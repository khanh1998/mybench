import { EventEmitter } from 'events';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import getDb from '$lib/server/db';
import { startSeries, getActiveSeries } from '$lib/server/series-executor';
import { createRun, completeRun } from '$lib/server/run-manager';
import type { ActiveRun } from '$lib/server/run-manager';
import {
	connectSsh,
	execStreamingCancellable,
	uploadFile,
	downloadFile,
	exec,
	shellQuote
} from '$lib/server/ec2-runner';
import { generatePlan } from '$lib/server/plan-generator';
import { importResultIntoRun } from '$lib/server/run-importer';
import type { Ec2Server } from '$lib/types';

const MB_PREFIX = '__MB__';

/**
 * Routes a __MB__ structured event from a suite's series command to the appropriate
 * DB updates and SSE events. The flat `run_index` maps to flatRuns[run_index].
 */
function handleSuiteEvent(
	flatRuns: Array<{ runId: number; token: string; profileName: string }>,
	activeRunMap: Map<number, ActiveRun>,
	emitter: SuiteEmitter,
	evt: Record<string, unknown>,
	db: ReturnType<typeof getDb>
): void {
	const now = new Date().toISOString();
	const runIndex = evt.run_index as number | undefined;
	const run = runIndex !== undefined ? flatRuns[runIndex] : undefined;
	const activeRun = run ? activeRunMap.get(run.runId) : undefined;

	switch (evt.event) {
		case 'run_start': {
			if (!run) break;
			db.prepare(`UPDATE benchmark_runs SET status='running', started_at=? WHERE id=?`).run(now, run.runId);
			break;
		}
		case 'step_start': {
			if (!run || !activeRun) break;
			const stepId = evt.step_id as number;
			const outputFile = (evt.output_file as string) ?? '';
			db.prepare(
				`UPDATE run_step_results SET status='running', started_at=?, output_file=? WHERE run_id=? AND step_id=?`
			).run(now, outputFile, run.runId, stepId);
			activeRun.emitter.emit('step', { step_id: stepId, status: 'running', started_at: now });
			break;
		}
		case 'step_done': {
			if (!run || !activeRun) break;
			const stepId = evt.step_id as number;
			const status = (evt.status as string) === 'completed' ? 'completed' : 'failed';
			db.prepare(
				`UPDATE run_step_results SET status=?, finished_at=? WHERE run_id=? AND step_id=?`
			).run(status, now, run.runId, stepId);
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
			// Signal the individual run's SSE stream (import happens in the batch loop below)
			if (activeRun) activeRun.emitter.emit('done');
			break;
		}
		case 'delay': {
			emitter.emit('line', `[suite] Sleeping ${evt.seconds}s between runs...`);
			break;
		}
	}
}

export interface SuiteDesignConfig {
	design_id: number;
	profile_ids: number[];  // ordered
}

export interface StartSuiteOptions {
	decision_id: number;
	designs: SuiteDesignConfig[];
	delay_seconds: number;
	name?: string;
	ec2_server_id?: number | null;
	server_id?: number;
	database?: string;
	snapshot_interval_seconds?: number;
	use_private_ip?: boolean;
}

export interface SuiteEmitter extends EventEmitter {
	emit(event: 'line', line: string): boolean;
	emit(event: 'series-done', data: { series_id: number; design_id: number; index: number }): boolean;
	emit(event: 'done'): boolean;
	on(event: 'line', listener: (line: string) => void): this;
	on(event: 'series-done', listener: (data: { series_id: number; design_id: number; index: number }) => void): this;
	on(event: 'done', listener: () => void): this;
}

const activeSuites = new Map<number, SuiteEmitter>();

export function getActiveSuite(suiteId: number): SuiteEmitter | undefined {
	return activeSuites.get(suiteId);
}

export function startSuite(opts: StartSuiteOptions): number {
	const db = getDb();

	if (opts.designs.length === 0) throw new Error('Suite requires at least one design');

	const suiteName = opts.name ?? `Suite ${new Date().toLocaleString()}`;
	const suiteResult = db.prepare(`
		INSERT INTO decision_suites (decision_id, name, status, created_at)
		VALUES (?, ?, 'running', ?)
	`).run(opts.decision_id, suiteName, new Date().toISOString());
	const suiteId = suiteResult.lastInsertRowid as number;

	const emitter = new EventEmitter() as SuiteEmitter;
	emitter.setMaxListeners(50);
	activeSuites.set(suiteId, emitter);

	if (opts.ec2_server_id) {
		const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(opts.ec2_server_id) as Ec2Server | undefined;
		if (!ec2Server) throw new Error(`EC2 server ${opts.ec2_server_id} not found`);

		executeEc2SuiteAsync(suiteId, opts, ec2Server, emitter).catch(() => {});
	} else {
		executeLocalSuiteAsync(suiteId, opts, emitter).catch(() => {});
	}

	return suiteId;
}

async function executeLocalSuiteAsync(
	suiteId: number,
	opts: StartSuiteOptions,
	emitter: SuiteEmitter
): Promise<void> {
	const db = getDb();
	const total = opts.designs.length;

	for (let i = 0; i < opts.designs.length; i++) {
		const dc = opts.designs[i];
		const design = db.prepare('SELECT name, database FROM designs WHERE id = ?').get(dc.design_id) as
			{ name: string; database: string } | undefined;
		const designName = design?.name ?? `Design ${dc.design_id}`;

		emitter.emit('line', `\n[suite] Design ${i + 1}/${total}: "${designName}"`);

		let seriesId: number;
		try {
			seriesId = startSeries({
				design_id: dc.design_id,
				profile_ids: dc.profile_ids,
				delay_seconds: opts.delay_seconds,
				name: designName,
				server_id: opts.server_id,
				database: opts.database,
				snapshot_interval_seconds: opts.snapshot_interval_seconds,
				suite_id: suiteId,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emitter.emit('line', `[suite] Failed to start series for design ${dc.design_id}: ${msg}`);
			continue;
		}

		const seriesEmitter = getActiveSeries(seriesId);
		if (seriesEmitter) {
			const fwd = (line: string) => emitter.emit('line', line);
			seriesEmitter.on('line', fwd);
			await new Promise<void>((resolve) => {
				seriesEmitter.once('done', () => {
					seriesEmitter.off('line', fwd);
					resolve();
				});
			});
		}

		emitter.emit('series-done', { series_id: seriesId, design_id: dc.design_id, index: i });
	}

	db.prepare(`UPDATE decision_suites SET status='completed', finished_at=? WHERE id=?`)
		.run(new Date().toISOString(), suiteId);
	emitter.emit('line', '\n[suite] All designs completed.');
	emitter.emit('done');
	setTimeout(() => activeSuites.delete(suiteId), 60_000);
}

interface SuiteRunEntry {
	runId: number;
	token: string;
	profileName: string;    // display name stored in DB
	cliProfileName: string; // empty string = use design defaults
	seriesId: number;
	designId: number;
	designToken: string;
}

async function executeEc2SuiteAsync(
	suiteId: number,
	opts: StartSuiteOptions,
	ec2Server: Ec2Server,
	emitter: SuiteEmitter
): Promise<void> {
	const db = getDb();
	const suiteToken = randomUUID();
	db.prepare(`UPDATE decision_suites SET ec2_run_token=? WHERE id=?`).run(suiteToken, suiteId);

	const sessionKey = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '_' + suiteToken.slice(0, 6);
	const binaryPath = `${ec2Server.remote_dir}/mybench-runner`;

	// Gather design info and create series + run rows upfront
	interface DesignEntry {
		designId: number;
		designName: string;
		designToken: string;
		seriesId: number;
		snapshot_interval_seconds: number;
		runs: SuiteRunEntry[];
	}
	const designEntries: DesignEntry[] = [];
	const now = new Date().toISOString();

	for (const dc of opts.designs) {
		const design = db.prepare(`
			SELECT name, database, pre_collect_secs, post_collect_secs, snapshot_interval_seconds
			FROM designs WHERE id = ?
		`).get(dc.design_id) as {
			name: string; database: string;
			pre_collect_secs: number; post_collect_secs: number; snapshot_interval_seconds: number;
		} | undefined;
		if (!design) continue;

		const designName = design.name;
		const designToken = randomUUID();
		const snapshot_interval_seconds = opts.snapshot_interval_seconds ?? design.snapshot_interval_seconds;

		const seriesResult = db.prepare(`
			INSERT INTO benchmark_series (design_id, name, delay_seconds, status, created_at, suite_id, ec2_run_token)
			VALUES (?, ?, ?, 'running', ?, ?, ?)
		`).run(dc.design_id, designName, opts.delay_seconds, now, suiteId, designToken);
		const seriesId = seriesResult.lastInsertRowid as number;

		const designSteps = db.prepare(
			'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
		).all(dc.design_id) as { id: number; position: number; name: string; type: string }[];

		const runs: SuiteRunEntry[] = [];
		for (const profileId of dc.profile_ids) {
			const profile = profileId === 0
				? null
				: db.prepare('SELECT name FROM design_param_profiles WHERE id = ?').get(profileId) as { name: string } | undefined;
			const profileName = profileId === 0 ? 'Default' : (profile?.name ?? '');
			const cliProfileName = profileId === 0 ? '' : (profile?.name ?? '');
			const runToken = randomUUID();

			const resolvedDatabase = opts.database || design.database;
			const runResult = db.prepare(`
				INSERT INTO benchmark_runs (
					design_id, database, status, started_at,
					snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
					name, profile_name, ec2_server_id, ec2_run_token, series_id
				) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				dc.design_id, resolvedDatabase, now,
				snapshot_interval_seconds, design.pre_collect_secs, design.post_collect_secs,
				profileName, profileName, opts.ec2_server_id, runToken, seriesId
			);
			const runId = runResult.lastInsertRowid as number;

			const insStep = db.prepare(
				`INSERT INTO run_step_results (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`
			);
			for (const step of designSteps) {
				insStep.run(runId, step.id, step.position, step.name, step.type);
			}

			runs.push({ runId, token: runToken, profileName, cliProfileName, seriesId, designId: dc.design_id, designToken });
		}

		designEntries.push({ designId: dc.design_id, designName, designToken, seriesId, snapshot_interval_seconds, runs });
	}

	// Flat list matching the series command's run_index order
	const flatRuns = designEntries.flatMap(de => de.runs);
	const activeRunMap = new Map<number, ActiveRun>();
	for (const run of flatRuns) {
		activeRunMap.set(run.runId, createRun(run.runId));
	}

	// Track run_done count per design to emit series-done at the right time
	const designRunDone = new Map<number, number>(); // seriesId → done count
	const designRunTotal = new Map<number, number>(); // seriesId → total runs
	for (const de of designEntries) {
		designRunDone.set(de.seriesId, 0);
		designRunTotal.set(de.seriesId, de.runs.length);
	}

	let conn: import('ssh2').Client | null = null;

	try {
		conn = await connectSsh(ec2Server);
		const homeDir = (await exec(conn, 'echo $HOME')).stdout.trim();
		const resolvedRemoteDir = ec2Server.remote_dir.replace(/^~/, homeDir);
		const resolvedLogDir = (ec2Server.log_dir || ec2Server.remote_dir).replace(/^~/, homeDir);
		const resolvedBinaryPath = binaryPath.replace(/^~/, homeDir);
		const resolvedCliLogDir = (ec2Server.cli_log_dir || '/tmp/gocli-logs').replace(/^~/, homeDir);

		const execLogPath = `${resolvedLogDir}/suite_${sessionKey}.log`;
		const debugLogPath = `${resolvedCliLogDir}/suite_${sessionKey}.log`;

		await exec(conn, `mkdir -p ${shellQuote(resolvedRemoteDir)} ${shellQuote(resolvedLogDir)} ${shellQuote(resolvedCliLogDir)}`);
		db.prepare(`UPDATE decision_suites SET exec_log_path=? WHERE id=?`).run(execLogPath, suiteId);

		// Upload one plan file per design
		for (const de of designEntries) {
			const plan = generatePlan(de.designId, {
				server_id: opts.server_id,
				snapshot_interval_seconds: de.snapshot_interval_seconds,
				use_private_ip: !!opts.use_private_ip
			});
			const localPlanPath = `/tmp/mybench-suite-plan-${de.designToken}.json`;
			writeFileSync(localPlanPath, JSON.stringify(plan));
			const remotePlanPath = `${resolvedRemoteDir}/plan-${de.designToken}.json`;
			await uploadFile(conn, localPlanPath, remotePlanPath);
			try { unlinkSync(localPlanPath); } catch { /* ignore */ }
		}

		// Build single series command across all designs × profiles — runs in background
		const cmdParts: string[] = [
			'nohup',
			shellQuote(resolvedBinaryPath),
			'series',
			'--json-events',
			'--exec-log', shellQuote(execLogPath),
			'--delay', String(opts.delay_seconds),
			'--log-dir', shellQuote(resolvedLogDir)
		];
		for (const de of designEntries) {
			const remotePlanPath = `${resolvedRemoteDir}/plan-${de.designToken}.json`;
			for (const run of de.runs) {
				const remoteResultPath = `${resolvedRemoteDir}/result-${run.token}.json`;
				cmdParts.push('--run', shellQuote(`${remotePlanPath},${run.cliProfileName},${remoteResultPath}`));
			}
		}
		cmdParts.push('>/dev/null', `2>${shellQuote(debugLogPath)}`, '&');

		emitter.emit('line', `[suite] Launching EC2 suite: ${designEntries.length} design(s), ${flatRuns.length} total runs`);
		await exec(conn, cmdParts.join(' '));

		// Wait for exec log to appear (up to 10s)
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const r = await exec(conn, `test -f ${shellQuote(execLogPath)} && echo y || echo n`);
			if (r.stdout.trim() === 'y') break;
			await new Promise((r) => setTimeout(r, 200));
		}

		// Tail exec log — drives DB updates; emit series-done per design as runs complete
		const { promise: tailPromise, cancel: stopTail } = execStreamingCancellable(
			conn,
			`timeout 86400 tail -n +1 -F ${shellQuote(execLogPath)}`,
			(line) => {
				if (line.startsWith(MB_PREFIX)) {
					try {
						const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
						handleSuiteEvent(flatRuns, activeRunMap, emitter, evt, db);

						// Emit series-done when all runs in a design have completed
						if (evt.event === 'run_done') {
							const runIndex = evt.run_index as number | undefined;
							if (runIndex !== undefined) {
								const seriesId = flatRuns[runIndex]?.seriesId;
								if (seriesId !== undefined) {
									const done = (designRunDone.get(seriesId) ?? 0) + 1;
									designRunDone.set(seriesId, done);
									if (done === designRunTotal.get(seriesId)) {
										const di = designEntries.findIndex(de => de.seriesId === seriesId);
										emitter.emit('series-done', { series_id: seriesId, design_id: designEntries[di]?.designId ?? 0, index: di });
									}
								}
							}
						}

						if (evt.event === 'series_done') stopTail();
					} catch { /* malformed — ignore */ }
					return;
				}
				emitter.emit('line', line);
			}
		);
		await tailPromise;

		// Reconnect for downloads (long tail channel may have aged out the connection)
		conn.end();
		conn = await connectSsh(ec2Server);

		// Import results in order (design by design)
		let runIndex = 0;
		for (let di = 0; di < designEntries.length; di++) {
			const de = designEntries[di];
			emitter.emit('line', `\n[suite] Importing results for design ${di + 1}/${designEntries.length}: "${de.designName}"`);

			for (const run of de.runs) {
				runIndex++;
				const remoteResultPath = `${resolvedRemoteDir}/result-${run.token}.json`;
				const localResultPath = `/tmp/mybench-suite-result-${run.token}.json`;
				try {
					await downloadFile(conn, remoteResultPath, localResultPath);
					const resultJson = JSON.parse(readFileSync(localResultPath, 'utf8'));
					importResultIntoRun(run.runId, resultJson);
					try { unlinkSync(localResultPath); } catch { /* ignore */ }
					emitter.emit('line', `[suite] Imported run ${runIndex} (profile: ${run.profileName})`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					emitter.emit('line', `[suite] Failed to import run ${runIndex}: ${msg}`);
					db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`)
						.run(new Date().toISOString(), run.runId);
				}
				completeRun(run.runId);
			}

			db.prepare(`UPDATE benchmark_series SET status='completed', finished_at=? WHERE id=?`)
				.run(new Date().toISOString(), de.seriesId);
		}

		// Cleanup remote files (plans + results); exec log and debug log stay on VPS
		try {
			const planFiles = designEntries.map(de => `${resolvedRemoteDir}/plan-${de.designToken}.json`);
			const resultFiles = designEntries.flatMap(de => de.runs.map(r => `${resolvedRemoteDir}/result-${r.token}.json`));
			await exec(conn, `rm -f ${[...planFiles, ...resultFiles].map(shellQuote).join(' ')}`);
		} catch { /* ignore */ }

		db.prepare(`UPDATE decision_suites SET status='completed', finished_at=? WHERE id=?`)
			.run(new Date().toISOString(), suiteId);
		emitter.emit('line', '\n[suite] EC2 suite completed.');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emitter.emit('line', `\n[suite] Fatal error: ${msg}`);
		db.prepare(`UPDATE decision_suites SET status='failed', finished_at=? WHERE id=?`)
			.run(new Date().toISOString(), suiteId);
		for (const de of designEntries) {
			db.prepare(`UPDATE benchmark_series SET status='failed', finished_at=? WHERE id=?`)
				.run(new Date().toISOString(), de.seriesId);
			for (const run of de.runs) {
				db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=? AND status='running'`)
					.run(new Date().toISOString(), run.runId);
				completeRun(run.runId);
			}
		}
	} finally {
		conn?.end();
		emitter.emit('done');
		setTimeout(() => activeSuites.delete(suiteId), 60_000);
	}
}

export function recoverStaleLocalSuites(): void {
	const db = getDb();
	const result = db.prepare(`
		UPDATE decision_suites SET status='failed', finished_at=?
		WHERE status='running' AND ec2_run_token IS NULL
	`).run(new Date().toISOString());
	if (result.changes > 0) {
		console.log(`[suite-executor] Marked ${result.changes} stale local suite(s) as failed`);
	}
}
