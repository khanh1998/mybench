import { EventEmitter } from 'events';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import getDb from '$lib/server/db';
import { createPool } from '$lib/server/pg-client';
import { getEnabledTablesForRun } from '$lib/server/pg-stats';
import { createRun } from '$lib/server/run-manager';
import { executeLocalRunAsync } from '$lib/server/run-executor';
import { BENCH_STEP_TYPES } from '$lib/server/step-executors';
import {
	connectSsh,
	execStreaming,
	uploadFile,
	downloadFile,
	shellQuote
} from '$lib/server/ec2-runner';
import { generatePlan } from '$lib/server/plan-generator';
import { importResultIntoRun } from '$lib/server/run-importer';
import type { Ec2Server, PgServer, DesignStep, PgbenchScript, DesignParam } from '$lib/types';

export interface StartSeriesOptions {
	design_id: number;
	profile_ids: number[];       // ordered — one run per profile
	delay_seconds: number;
	name?: string;
	ec2_server_id?: number | null;
	server_id?: number;
	database?: string;
	snapshot_interval_seconds?: number;
}

export interface SeriesEmitter extends EventEmitter {
	emit(event: 'line', line: string): boolean;
	emit(event: 'progress', data: { current: number; total: number; current_run_id: number | null }): boolean;
	emit(event: 'done'): boolean;
	on(event: 'line', listener: (line: string) => void): this;
	on(event: 'progress', listener: (data: { current: number; total: number; current_run_id: number | null }) => void): this;
	on(event: 'done', listener: () => void): this;
}

// In-memory map of active series emitters (for live SSE streaming)
const activeSeries = new Map<number, SeriesEmitter>();

export function getActiveSeries(seriesId: number): SeriesEmitter | undefined {
	return activeSeries.get(seriesId);
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

	const seriesName = opts.name ?? `Series ${new Date().toLocaleString()}`;
	const delaySeconds = opts.delay_seconds ?? 0;
	const snapshot_interval_seconds = opts.snapshot_interval_seconds ?? design.snapshot_interval_seconds ?? 30;
	const resolvedDatabase = opts.database ?? design.database;

	const seriesResult = db.prepare(`
		INSERT INTO benchmark_series (design_id, name, delay_seconds, status, created_at)
		VALUES (?, ?, ?, 'running', ?)
	`).run(opts.design_id, seriesName, delaySeconds, new Date().toISOString());
	const seriesId = seriesResult.lastInsertRowid as number;

	const emitter = new EventEmitter() as SeriesEmitter;
	emitter.setMaxListeners(50);
	activeSeries.set(seriesId, emitter);

	if (opts.ec2_server_id) {
		// EC2 path: pre-create all run rows with status='running' + individual tokens
		const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(opts.ec2_server_id) as Ec2Server | undefined;
		if (!ec2Server) throw new Error(`EC2 server ${opts.ec2_server_id} not found`);

		const seriesToken = randomUUID();
		db.prepare(`UPDATE benchmark_series SET ec2_run_token=? WHERE id=?`).run(seriesToken, seriesId);

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

			// Placeholder step result for SSE streaming
			db.prepare(`
				INSERT INTO run_step_results (run_id, step_id, position, name, type, status, started_at)
				VALUES (?, 0, 0, 'EC2 Remote Execution', 'sql', 'running', ?)
			`).run(runId, now);

			entries.push({ runId, token: runToken, profileName });
		}

		executeEc2SeriesAsync(
			seriesId, seriesToken, entries, design.id, ec2Server,
			opts.server_id, resolvedDatabase, snapshot_interval_seconds, delaySeconds, emitter
		).catch(() => {});
	} else {
		// Local path: pre-create run rows with status='pending'
		const resolvedServerId = opts.server_id ?? design.server_id;
		if (!resolvedServerId) throw new Error('Server not configured for this design');

		const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(resolvedServerId) as PgServer | undefined;
		if (!server) throw new Error(`Server ${resolvedServerId} not found`);

		const entries: { runId: number; profileId: number; profileName: string }[] = [];

		for (const profileId of opts.profile_ids) {
			const profile = db.prepare('SELECT name FROM design_param_profiles WHERE id = ?').get(profileId) as { name: string } | undefined;
			const profileName = profile?.name ?? '';

			const insertResult = db.prepare(`
				INSERT INTO benchmark_runs (
					design_id, database, status, started_at,
					snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
					name, profile_name, series_id
				) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
			`).run(
				design.id, resolvedDatabase, new Date().toISOString(),
				snapshot_interval_seconds, design.pre_collect_secs, design.post_collect_secs,
				profileName, profileName, seriesId
			);
			const runId = insertResult.lastInsertRowid as number;

			// Pre-create step results so SSE can replay them
			const steps = db.prepare(
				'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
			).all(design.id) as DesignStep[];
			const insertStepResult = db.prepare(
				`INSERT INTO run_step_results (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`
			);
			for (const step of steps) {
				insertStepResult.run(runId, step.id, step.position, step.name, step.type);
			}

			entries.push({ runId, profileId, profileName });
		}

		executeLocalSeriesAsync(
			seriesId, entries, design.id, server, resolvedDatabase,
			snapshot_interval_seconds, delaySeconds, emitter
		).catch(() => {});
	}

	return seriesId;
}

async function executeLocalSeriesAsync(
	seriesId: number,
	entries: { runId: number; profileId: number; profileName: string }[],
	designId: number,
	server: PgServer,
	resolvedDatabase: string,
	snapshot_interval_seconds: number,
	delaySeconds: number,
	emitter: SeriesEmitter
): Promise<void> {
	const db = getDb();

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const total = entries.length;

		if (i > 0 && delaySeconds > 0) {
			emitter.emit('line', `\n[series] Waiting ${delaySeconds}s before next run...`);
			await new Promise(r => setTimeout(r, delaySeconds * 1000));
		}

		emitter.emit('line', `\n[series] Starting run ${i + 1}/${total}: profile "${entry.profileName}"`);
		emitter.emit('progress', { current: i + 1, total, current_run_id: entry.runId });

		const now = new Date().toISOString();
		db.prepare(`UPDATE benchmark_runs SET status='running', started_at=? WHERE id=?`).run(now, entry.runId);

		// Load design data
		const steps = db.prepare(
			'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
		).all(designId) as DesignStep[];

		const pgbenchScripts = db.prepare(
			'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ? AND enabled = 1) ORDER BY step_id, position'
		).all(designId) as PgbenchScript[];

		const scriptsByStep = new Map<number, PgbenchScript[]>();
		for (const ps of pgbenchScripts) {
			const arr = scriptsByStep.get(ps.step_id) ?? [];
			arr.push(ps);
			scriptsByStep.set(ps.step_id, arr);
		}

		const designParams = db.prepare(
			'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
		).all(designId) as DesignParam[];

		// Merge profile overrides
		let resolvedParams: DesignParam[] = designParams;
		const profileValues = db.prepare(
			'SELECT * FROM design_param_profile_values WHERE profile_id = ?'
		).all(entry.profileId) as { param_name: string; value: string }[];
		if (profileValues.length > 0) {
			const overrideMap = new Map(profileValues.map(v => [v.param_name, v.value]));
			resolvedParams = designParams.map(p => overrideMap.has(p.name) ? { ...p, value: overrideMap.get(p.name)! } : p);
		}
		const runParamsJson = resolvedParams.length > 0
			? JSON.stringify(resolvedParams.map(p => ({ name: p.name, value: p.value })))
			: '';
		db.prepare(`UPDATE benchmark_runs SET run_params=? WHERE id=?`).run(runParamsJson, entry.runId);

		// Compute collect timing
		const hasCollectSteps = steps.some(s => s.type === 'collect');
		const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId) as {
			pre_collect_secs: number; post_collect_secs: number;
		};
		let preCollectSecs: number;
		let postCollectSecs: number;
		if (hasCollectSteps) {
			const firstPgbenchPos = steps.find(s => BENCH_STEP_TYPES.includes(s.type))?.position ?? Infinity;
			const lastPgbenchPos = [...steps].reverse().find(s => BENCH_STEP_TYPES.includes(s.type))?.position ?? -Infinity;
			preCollectSecs = steps.filter(s => s.type === 'collect' && s.position < firstPgbenchPos).reduce((sum, s) => sum + (s.duration_secs ?? 0), 0);
			postCollectSecs = steps.filter(s => s.type === 'collect' && s.position > lastPgbenchPos).reduce((sum, s) => sum + (s.duration_secs ?? 0), 0);
		} else {
			preCollectSecs = design.pre_collect_secs ?? 0;
			postCollectSecs = design.post_collect_secs ?? 0;
		}

		db.prepare(`UPDATE benchmark_runs SET pre_collect_secs=?, post_collect_secs=? WHERE id=?`)
			.run(preCollectSecs, postCollectSecs, entry.runId);

		// Create active run and attach series emitter forwarding
		const activeRun = createRun(entry.runId);
		activeRun.emitter.on('line', (line: string) => emitter.emit('line', line));

		try {
			await executeLocalRunAsync(
				entry.runId, activeRun, server, resolvedDatabase, resolvedParams,
				steps, scriptsByStep, snapshot_interval_seconds,
				hasCollectSteps, preCollectSecs, postCollectSecs
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emitter.emit('line', `\n[series] Run ${i + 1} error: ${msg}`);
		}
	}

	db.prepare(`UPDATE benchmark_series SET status='completed', finished_at=? WHERE id=?`)
		.run(new Date().toISOString(), seriesId);
	emitter.emit('line', '\n[series] All runs completed.');
	emitter.emit('done');
	setTimeout(() => activeSeries.delete(seriesId), 60_000);
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
	emitter: SeriesEmitter
): Promise<void> {
	const db = getDb();
	const remoteDir = ec2Server.remote_dir;
	const logDir = ec2Server.log_dir || remoteDir;
	const binaryPath = `${remoteDir}/mybench-runner`;

	let conn: import('ssh2').Client | null = null;

	try {
		conn = await connectSsh(ec2Server);

		// Resolve ~ to $HOME for SFTP (fastPut/fastGet don't expand tildes)
		const { exec } = await import('$lib/server/ec2-runner');
		const homeResult = await exec(conn, 'echo $HOME');
		const homeDir = homeResult.stdout.trim();
		const resolvedRemoteDir = remoteDir.replace(/^~/, homeDir);
		const resolvedLogDir = logDir.replace(/^~/, homeDir);
		const resolvedBinaryPath = binaryPath.replace(/^~/, homeDir);

		// Ensure remote directory exists
		await exec(conn, `mkdir -p ${shellQuote(resolvedRemoteDir)}`);

		// Generate and upload a single plan file (reused for all runs)
		const plan = generatePlan(designId, { server_id: overrideServerId, database: resolvedDatabase, snapshot_interval_seconds });
		const localPlanPath = `/tmp/mybench-series-${seriesToken}.json`;
		writeFileSync(localPlanPath, JSON.stringify(plan));
		const remotePlanPath = `${resolvedRemoteDir}/plan-${seriesToken}.json`;
		await uploadFile(conn, localPlanPath, remotePlanPath);
		try { unlinkSync(localPlanPath); } catch { /* ignore */ }

		// Build series command
		const cmdParts: string[] = [
			shellQuote(resolvedBinaryPath),
			'series',
			'--delay', String(delaySeconds),
			'--log-dir', shellQuote(resolvedLogDir)
		];
		for (const entry of entries) {
			const remoteResultPath = `${resolvedRemoteDir}/result-${entry.token}.json`;
			cmdParts.push('--run', shellQuote(`${remotePlanPath},${entry.profileName},${remoteResultPath}`));
		}
		const cmd = cmdParts.join(' ');

		emitter.emit('line', `[series] Starting EC2 series: ${entries.length} runs, ${delaySeconds}s delay`);
		emitter.emit('line', `[series] Command: ${cmd}`);

		// Stream output
		const exitCode = await execStreaming(conn, cmd, (line) => {
			emitter.emit('line', line);
			// Update each run's step result stdout as we go (best effort)
		});

		if (exitCode !== 0) {
			emitter.emit('line', `[series] EC2 series exited with code ${exitCode}`);
		}

		// Download and import each result
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const remoteResultPath = `${resolvedRemoteDir}/result-${entry.token}.json`;
			const localResultPath = `/tmp/mybench-series-result-${entry.token}.json`;

			try {
				await downloadFile(conn, remoteResultPath, localResultPath);
				const resultJson = JSON.parse(readFileSync(localResultPath, 'utf8'));
				await importResultIntoRun(entry.runId, resultJson);
				try { unlinkSync(localResultPath); } catch { /* ignore */ }
				emitter.emit('progress', { current: i + 1, total: entries.length, current_run_id: entry.runId });
				emitter.emit('line', `[series] Imported result for run ${i + 1}/${entries.length} (profile: ${entry.profileName})`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				emitter.emit('line', `[series] Failed to import result for run ${i + 1}: ${msg}`);
				db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`)
					.run(new Date().toISOString(), entry.runId);
			}
		}

		// Cleanup remote plan file
		try {
			await exec(conn, `rm -f ${shellQuote(remotePlanPath)}`);
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
		}
	} finally {
		conn?.end();
		emitter.emit('done');
		setTimeout(() => activeSeries.delete(seriesId), 60_000);
	}
}

/**
 * Called at startup. Marks any local series that were 'running' (without EC2 token) as failed.
 * The run rows are already reset by recoverStaleRuns() in run-manager.ts.
 */
export function recoverLocalSeries(): void {
	const db = getDb();
	const result = db.prepare(`
		UPDATE benchmark_series SET status='failed', finished_at=?
		WHERE status='running' AND ec2_run_token IS NULL
	`).run(new Date().toISOString());
	if (result.changes > 0) {
		console.log(`[series-executor] Marked ${result.changes} stale local series as failed`);
	}
}
