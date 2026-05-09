import { EventEmitter } from 'events';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import getDb from '$lib/server/db';
import { createRun, completeRun } from '$lib/server/run-manager';
import type { ActiveRun } from '$lib/server/run-manager';
import {
	connectSsh,
	execStreaming,
	uploadFile,
	downloadFile,
	shellQuote
} from '$lib/server/ec2-runner';
import { generatePlan } from '$lib/server/plan-generator';
import { importResultIntoRun } from '$lib/server/run-importer';
import type { Ec2Server } from '$lib/types';

export interface StartSeriesOptions {
	design_id: number;
	profile_ids: number[];       // ordered — one run per profile
	delay_seconds: number;
	name?: string;
	ec2_server_id?: number | null;
	server_id?: number;
	database?: string;
	snapshot_interval_seconds?: number;
	use_private_ip?: boolean;
	suite_id?: number;           // optional — set when series is part of a decision suite
}

export interface SeriesEmitter extends EventEmitter {
	emit(event: 'line', line: string): boolean;
	emit(event: 'progress', data: { current: number; total: number; current_run_id: number | null }): boolean;
	emit(event: 'done'): boolean;
	on(event: 'line', listener: (line: string) => void): this;
	on(event: 'progress', listener: (data: { current: number; total: number; current_run_id: number | null }) => void): this;
	on(event: 'done', listener: () => void): this;
}

const MB_PREFIX = '__MB__';

// In-memory map of active series emitters (for live SSE streaming)
const activeSeries = new Map<number, SeriesEmitter>();

export function getActiveSeries(seriesId: number): SeriesEmitter | undefined {
	return activeSeries.get(seriesId);
}

/**
 * Routes a __MB__ structured event from the Go CLI series command to the appropriate
 * DB updates and SSE events, keyed by run_index → entries[run_index].runId.
 */
function handleSeriesEvent(
	entries: Array<{ runId: number; token: string; profileName: string }>,
	activeRunMap: Map<number, ActiveRun>,
	emitter: SeriesEmitter,
	evt: Record<string, unknown>,
	db: ReturnType<typeof getDb>
): void {
	const now = new Date().toISOString();
	const runIndex = evt.run_index as number | undefined;
	const entry = runIndex !== undefined ? entries[runIndex] : undefined;
	const activeRun = entry ? activeRunMap.get(entry.runId) : undefined;

	switch (evt.event) {
		case 'run_start': {
			if (!entry) break;
			db.prepare(`UPDATE benchmark_runs SET status='running', started_at=? WHERE id=?`).run(now, entry.runId);
			emitter.emit('progress', {
				current: (runIndex ?? 0) + 1,
				total: entries.length,
				current_run_id: entry.runId
			});
			break;
		}
		case 'step_start': {
			if (!entry || !activeRun) break;
			const stepId = evt.step_id as number;
			db.prepare(
				`UPDATE run_step_results SET status='running', started_at=? WHERE run_id=? AND step_id=?`
			).run(now, entry.runId, stepId);
			activeRun.emitter.emit('step', { step_id: stepId, status: 'running', started_at: now });
			break;
		}
		case 'step_done': {
			if (!entry || !activeRun) break;
			const stepId = evt.step_id as number;
			const status = (evt.status as string) === 'completed' ? 'completed' : 'failed';
			db.prepare(
				`UPDATE run_step_results SET status=?, finished_at=? WHERE run_id=? AND step_id=?`
			).run(status, now, entry.runId, stepId);
			activeRun.emitter.emit('step', { step_id: stepId, status, finished_at: now });
			break;
		}
		case 'phase': {
			if (!activeRun) break;
			activeRun.emitter.emit('phase', {
				name: evt.name as string,
				status: evt.status as string,
				duration_secs: (evt.duration_secs as number) ?? 0,
				started_ms: Date.now()
			});
			break;
		}
		case 'run_done': {
			// Signal the individual run's SSE stream that it's done (the final import
			// happens in the batch download loop after the series command exits).
			if (activeRun) activeRun.emitter.emit('done');
			break;
		}
		case 'delay': {
			emitter.emit('line', `[series] Sleeping ${evt.seconds}s between runs...`);
			break;
		}
		// series_done: handled by the caller — no action needed here
	}
}

/**
 * Creates a benchmark_series row, pre-creates benchmark_runs rows,
 * and fires async execution. Returns the series_id immediately.
 */
export function startSeries(opts: StartSeriesOptions): number {
	const db = getDb();

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(opts.design_id) as {
		id: number; name: string; database: string; server_id: number | null;
		pre_collect_secs: number; post_collect_secs: number; snapshot_interval_seconds: number;
	} | undefined;
	if (!design) throw new Error(`Design ${opts.design_id} not found`);

	if (!opts.ec2_server_id) throw new Error('ec2_server_id is required');

	const seriesName = opts.name ?? `Series ${new Date().toLocaleString()}`;
	const delaySeconds = opts.delay_seconds ?? 0;
	const snapshot_interval_seconds = opts.snapshot_interval_seconds ?? design.snapshot_interval_seconds ?? 30;
	const resolvedDatabase = opts.database ?? design.database;

	const seriesResult = db.prepare(`
		INSERT INTO benchmark_series (design_id, name, delay_seconds, status, created_at, suite_id)
		VALUES (?, ?, ?, 'running', ?, ?)
	`).run(opts.design_id, seriesName, delaySeconds, new Date().toISOString(), opts.suite_id ?? null);
	const seriesId = seriesResult.lastInsertRowid as number;

	const emitter = new EventEmitter() as SeriesEmitter;
	emitter.setMaxListeners(50);
	activeSeries.set(seriesId, emitter);

	const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(opts.ec2_server_id) as Ec2Server | undefined;
	if (!ec2Server) throw new Error(`EC2 server ${opts.ec2_server_id} not found`);

	const seriesToken = randomUUID();
	db.prepare(`UPDATE benchmark_series SET ec2_run_token=? WHERE id=?`).run(seriesToken, seriesId);

	// Load design steps once for pre-creating step result rows
	const designSteps = db.prepare(
		'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
	).all(design.id) as { id: number; position: number; name: string; type: string }[];

	const entries: { runId: number; token: string; profileName: string }[] = [];
	const now = new Date().toISOString();

	for (const profileId of opts.profile_ids) {
		const profile = db.prepare('SELECT name FROM design_param_profiles WHERE id = ?').get(profileId) as { name: string } | undefined;
		const profileName = profile?.name ?? '';
		const runToken = randomUUID();

		const insertResult = db.prepare(`
			INSERT INTO benchmark_runs (
				design_id, database, status, started_at,
				snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
				name, profile_name, ec2_server_id, ec2_run_token, series_id
			) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			design.id, resolvedDatabase, now,
			snapshot_interval_seconds, design.pre_collect_secs, design.post_collect_secs,
			profileName, profileName, opts.ec2_server_id, runToken, seriesId
		);
		const runId = insertResult.lastInsertRowid as number;

		// Pre-create real per-step result rows
		const insStep = db.prepare(
			`INSERT INTO run_step_results (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`
		);
		for (const step of designSteps) {
			insStep.run(runId, step.id, step.position, step.name, step.type);
		}

		entries.push({ runId, token: runToken, profileName });
	}

	executeEc2SeriesAsync(
		seriesId, seriesToken, entries, design.id, ec2Server,
		opts.server_id, resolvedDatabase, snapshot_interval_seconds, delaySeconds, emitter,
		!!opts.use_private_ip
	).catch(() => {});

	return seriesId;
}

async function executeEc2SeriesAsync(
	seriesId: number,
	seriesToken: string,
	entries: { runId: number; token: string; profileName: string }[],
	designId: number,
	ec2Server: Ec2Server,
	overrideServerId: number | undefined,
	resolvedDatabase: string,
	snapshot_interval_seconds: number,
	delaySeconds: number,
	emitter: SeriesEmitter,
	usePrivateIp = false
): Promise<void> {
	const db = getDb();
	const remoteDir = ec2Server.remote_dir;
	const logDir = ec2Server.log_dir || remoteDir;
	const binaryPath = `${remoteDir}/mybench-runner`;

	// Create ActiveRun for each entry upfront so SSE subscribers can connect
	// to individual run streams before their run actually starts.
	const activeRunMap = new Map<number, ActiveRun>();
	for (const entry of entries) {
		activeRunMap.set(entry.runId, createRun(entry.runId));
	}

	let conn: import('ssh2').Client | null = null;

	try {
		conn = await connectSsh(ec2Server);

		const { exec } = await import('$lib/server/ec2-runner');
		const homeResult = await exec(conn, 'echo $HOME');
		const homeDir = homeResult.stdout.trim();
		const resolvedRemoteDir = remoteDir.replace(/^~/, homeDir);
		const resolvedLogDir = logDir.replace(/^~/, homeDir);
		const resolvedBinaryPath = binaryPath.replace(/^~/, homeDir);

		await exec(conn, `mkdir -p ${shellQuote(resolvedRemoteDir)}`);

		// Generate and upload a single plan file (reused for all runs)
		const plan = generatePlan(designId, {
			server_id: overrideServerId,
			database: resolvedDatabase,
			snapshot_interval_seconds,
			use_private_ip: usePrivateIp
		});
		const localPlanPath = `/tmp/mybench-series-${seriesToken}.json`;
		writeFileSync(localPlanPath, JSON.stringify(plan));
		const remotePlanPath = `${resolvedRemoteDir}/plan-${seriesToken}.json`;
		await uploadFile(conn, localPlanPath, remotePlanPath);
		try { unlinkSync(localPlanPath); } catch { /* ignore */ }

		// Build series command with --json-events
		const cmdParts: string[] = [
			shellQuote(resolvedBinaryPath),
			'series',
			'--json-events',
			'--delay', String(delaySeconds),
			'--log-dir', shellQuote(resolvedLogDir)
		];
		for (const entry of entries) {
			const remoteResultPath = `${resolvedRemoteDir}/result-${entry.token}.json`;
			cmdParts.push('--run', shellQuote(`${remotePlanPath},${entry.profileName},${remoteResultPath}`));
		}
		const cmd = cmdParts.join(' ');

		emitter.emit('line', `[series] Starting EC2 series: ${entries.length} runs, ${delaySeconds}s delay`);

		// Stream output — parse __MB__ events, forward plain lines to series SSE
		const exitCode = await execStreaming(conn, cmd, (line) => {
			if (line.startsWith(MB_PREFIX)) {
				try {
					const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
					handleSeriesEvent(entries, activeRunMap, emitter, evt, db);
				} catch { /* malformed — ignore */ }
				return;
			}
			emitter.emit('line', line);
		});

		if (exitCode !== 0) {
			emitter.emit('line', `[series] EC2 series exited with code ${exitCode}`);
		}

		// Download and import each result in order
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const remoteResultPath = `${resolvedRemoteDir}/result-${entry.token}.json`;
			const localResultPath = `/tmp/mybench-series-result-${entry.token}.json`;

			try {
				await downloadFile(conn, remoteResultPath, localResultPath);
				const resultJson = JSON.parse(readFileSync(localResultPath, 'utf8'));
				importResultIntoRun(entry.runId, resultJson);
				try { unlinkSync(localResultPath); } catch { /* ignore */ }
				emitter.emit('line', `[series] Imported result for run ${i + 1}/${entries.length} (profile: ${entry.profileName})`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				emitter.emit('line', `[series] Failed to import result for run ${i + 1}: ${msg}`);
				db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`)
					.run(new Date().toISOString(), entry.runId);
			}

			// Signal the individual run's SSE stream and clean up its ActiveRun
			completeRun(entry.runId);
		}

		// Cleanup remote files (plan, all result files, log dir)
		try {
			const filesToRemove = [remotePlanPath, ...entries.map(e => `${resolvedRemoteDir}/result-${e.token}.json`)];
			await exec(conn, `rm -f ${filesToRemove.map(shellQuote).join(' ')} && rm -rf ${shellQuote(resolvedLogDir)}`);
		} catch { /* ignore */ }

		db.prepare(`UPDATE benchmark_series SET status='completed', finished_at=? WHERE id=?`)
			.run(new Date().toISOString(), seriesId);
		emitter.emit('line', '\n[series] EC2 series completed.');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emitter.emit('line', `\n[series] Fatal error: ${msg}`);
		db.prepare(`UPDATE benchmark_series SET status='failed', finished_at=? WHERE id=?`)
			.run(new Date().toISOString(), seriesId);
		// Mark any still-running runs as failed
		for (const entry of entries) {
			db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=? AND status='running'`)
				.run(new Date().toISOString(), entry.runId);
			completeRun(entry.runId);
		}
	} finally {
		conn?.end();
		emitter.emit('done');
		setTimeout(() => activeSeries.delete(seriesId), 60_000);
	}
}
