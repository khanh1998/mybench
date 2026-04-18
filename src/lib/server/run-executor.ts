import getDb from '$lib/server/db';
import { createPool } from '$lib/server/pg-client';
import {
	collectForDuration,
	getEnabledTablesForRun
} from '$lib/server/pg-stats';
import { createRun, completeRun, setPool, setActivePhase } from '$lib/server/run-manager';
import { substituteParams } from '$lib/server/params';
import { getStepExecutor, BENCH_STEP_TYPES } from '$lib/server/step-executors';
import type { PgServer, DesignStep, PgbenchScript, DesignParam } from '$lib/types';

export interface StartRunOptions {
	server_id?: number;
	database?: string;
	snapshot_interval_seconds?: number;
	profile_id?: number;
	name?: string;
}

/**
 * Creates a benchmark_runs row and starts async execution.
 * Returns immediately with the new run_id.
 * Reused by both the HTTP API and the MCP tool.
 */
export function startRun(designId: number, opts: StartRunOptions = {}): number {
	const db = getDb();
	const snapshot_interval_seconds = opts.snapshot_interval_seconds ?? 30;

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(designId)) as {
		id: number; decision_id: number; name: string; server_id: number; database: string;
		pre_collect_secs: number; post_collect_secs: number;
	} | undefined;
	if (!design) throw new Error(`Design ${designId} not found`);

	const resolvedServerId = opts.server_id ?? design.server_id;
	const resolvedDatabase: string = opts.database ?? design.database;

	const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(resolvedServerId) as PgServer | undefined;
	if (!server) throw new Error('Server not configured for this design');

	const steps = db.prepare(
		'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
	).all(design.id) as DesignStep[];

	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ? AND enabled = 1) ORDER BY step_id, position'
	).all(design.id) as PgbenchScript[];

	const scriptsByStep = new Map<number, PgbenchScript[]>();
	for (const ps of pgbenchScripts) {
		const arr = scriptsByStep.get(ps.step_id) ?? [];
		arr.push(ps);
		scriptsByStep.set(ps.step_id, arr);
	}

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(design.id) as DesignParam[];

	// Merge profile overrides if a profile_id was provided
	let resolvedParams: DesignParam[] = designParams;
	let profileName = '';
	if (opts.profile_id) {
		const profile = db.prepare('SELECT * FROM design_param_profiles WHERE id = ?').get(opts.profile_id) as { id: number; design_id: number; name: string } | undefined;
		if (profile) {
			profileName = profile.name;
			const profileValues = db.prepare('SELECT * FROM design_param_profile_values WHERE profile_id = ?').all(opts.profile_id) as { param_name: string; value: string }[];
			const overrideMap = new Map(profileValues.map(v => [v.param_name, v.value]));
			resolvedParams = designParams.map(p => overrideMap.has(p.name) ? { ...p, value: overrideMap.get(p.name)! } : p);
		}
	}
	const runName = opts.name ?? (profileName || '');
	const runParamsJson = resolvedParams.length > 0 ? JSON.stringify(resolvedParams.map(p => ({ name: p.name, value: p.value }))) : '';

	const hasCollectSteps = steps.some(s => s.type === 'collect');
	let preCollectSecs: number;
	let postCollectSecs: number;
	if (hasCollectSteps) {
		const firstBenchPos = steps.find(s => BENCH_STEP_TYPES.includes(s.type))?.position ?? Infinity;
		const lastBenchPos = [...steps].reverse().find(s => BENCH_STEP_TYPES.includes(s.type))?.position ?? -Infinity;
		preCollectSecs = steps.filter(s => s.type === 'collect' && s.position < firstBenchPos).reduce((sum, s) => sum + (s.duration_secs ?? 0), 0);
		postCollectSecs = steps.filter(s => s.type === 'collect' && s.position > lastBenchPos).reduce((sum, s) => sum + (s.duration_secs ?? 0), 0);
	} else {
		preCollectSecs = design.pre_collect_secs ?? 0;
		postCollectSecs = design.post_collect_secs ?? 0;
	}

	const runResult = db.prepare(
		'INSERT INTO benchmark_runs (design_id, database, status, snapshot_interval_seconds, pre_collect_secs, post_collect_secs, name, profile_name, run_params, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
	).run(design.id, resolvedDatabase, 'running', snapshot_interval_seconds, preCollectSecs, postCollectSecs, runName, profileName, runParamsJson, new Date().toISOString());
	const runId = runResult.lastInsertRowid as number;

	const insertStepResult = db.prepare(
		`INSERT INTO run_step_results (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`
	);
	for (const step of steps) {
		insertStepResult.run(runId, step.id, step.position, step.name, step.type);
	}

	const activeRun = createRun(runId);
	executeLocalRunAsync(runId, activeRun, server, resolvedDatabase, resolvedParams, steps, scriptsByStep, snapshot_interval_seconds, hasCollectSteps, preCollectSecs, postCollectSecs).catch(() => {});

	return runId;
}

/**
 * Executes the async body of a local run. Called by startRun (fire-and-forget)
 * and by series-executor (awaited, for sequential series execution).
 * Assumes the benchmark_runs row and run_step_results rows already exist.
 */
export async function executeLocalRunAsync(
	runId: number,
	activeRun: import('./run-manager').ActiveRun,
	server: PgServer,
	resolvedDatabase: string,
	resolvedParams: DesignParam[],
	steps: DesignStep[],
	scriptsByStep: Map<number, PgbenchScript[]>,
	snapshot_interval_seconds: number,
	hasCollectSteps: boolean,
	preCollectSecs: number,
	postCollectSecs: number
): Promise<void> {
	const db = getDb();

	const pool = createPool(server, resolvedDatabase);
	setPool(runId, pool);
	const enabledTables = getEnabledTablesForRun(server.id);

	try {
		if (!hasCollectSteps && preCollectSecs > 0 && enabledTables.length > 0) {
			const prePhase = { name: 'pre' as const, status: 'running' as const, duration_secs: preCollectSecs, started_ms: Date.now() };
			setActivePhase(runId, prePhase);
			activeRun.emitter.emit('phase', prePhase);
			activeRun.emitter.emit('line', `[snapshot] Pre-benchmark collection (${preCollectSecs}s)...`);
			await collectForDuration(pool, runId, enabledTables, 'pre', preCollectSecs, snapshot_interval_seconds);
			const prePhoneDone = { ...prePhase, status: 'completed' as const };
			setActivePhase(runId, prePhoneDone);
			activeRun.emitter.emit('phase', prePhoneDone);
		}

		let seenBench = false;
		for (const step of steps) {
			const startedAt = new Date().toISOString();
			db.prepare(`UPDATE run_step_results SET status='running', started_at=? WHERE run_id=? AND step_id=?`).run(startedAt, runId, step.id);
			activeRun.emitter.emit('step', { step_id: step.id, status: 'running', started_at: startedAt });
			activeRun.emitter.emit('line', `\n=== Step: ${step.name} (${step.type}) ===`);

			let stdout = '';
			let stderr = '';
			const LOG_CAP = 500_000;

			const onLine = (line: string, stream: 'stdout' | 'stderr') => {
				if (stream === 'stdout') {
					if (stdout.length < LOG_CAP) stdout += line + '\n';
					else if (!stdout.endsWith('[truncated]\n')) stdout += '[truncated]\n';
				} else {
					if (stderr.length < LOG_CAP) stderr += line + '\n';
					else if (!stderr.endsWith('[truncated]\n')) stderr += '[truncated]\n';
				}
			};
			const logStepLine = (line: string, stream: 'stdout' | 'stderr' = 'stdout') => {
				activeRun.emitter.emit('line', line);
				onLine(line, stream);
			};

			const execute = getStepExecutor(step.type);
			const result = await execute({
				step, runId, server, resolvedDatabase, resolvedParams,
				pool, enabledTables, snapshotIntervalSecs: snapshot_interval_seconds,
				activeRun, onLine, logStepLine, scriptsByStep, seenBench
			});

			if (BENCH_STEP_TYPES.includes(step.type)) seenBench = true;

			const exitCode = result.exitCode;
			const stepStatus = exitCode === 0 ? 'completed' : 'failed';
			const finishedAt = new Date().toISOString();
			db.prepare(
				`UPDATE run_step_results SET status=?, stdout=?, stderr=?, exit_code=?, finished_at=? WHERE run_id=? AND step_id=?`
			).run(stepStatus, stdout, stderr, exitCode, finishedAt, runId, step.id);
			activeRun.emitter.emit('step', { step_id: step.id, status: stepStatus, finished_at: finishedAt });

			if (stepStatus === 'failed') {
				activeRun.emitter.emit('line', `\n[ERROR] Step "${step.name}" failed with exit code ${exitCode}. Stopping.`);
				db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`).run(new Date().toISOString(), runId);
				return;
			}
		}

		if (!hasCollectSteps && postCollectSecs > 0 && enabledTables.length > 0) {
			const postStartedAt = new Date().toISOString();
			db.prepare(`UPDATE benchmark_runs SET post_started_at=? WHERE id=?`).run(postStartedAt, runId);
			const postPhase = { name: 'post' as const, status: 'running' as const, duration_secs: postCollectSecs, started_ms: Date.now() };
			setActivePhase(runId, postPhase);
			activeRun.emitter.emit('phase', postPhase);
			activeRun.emitter.emit('line', `\n[snapshot] Post-benchmark collection (${postCollectSecs}s)...`);
			await collectForDuration(pool, runId, enabledTables, 'post', postCollectSecs, snapshot_interval_seconds);
			const postPhaseDone = { ...postPhase, status: 'completed' as const };
			setActivePhase(runId, null);
			activeRun.emitter.emit('phase', postPhaseDone);
		}

		db.prepare(`UPDATE benchmark_runs SET status='completed', finished_at=? WHERE id=?`).run(new Date().toISOString(), runId);
		activeRun.emitter.emit('line', '\n=== Benchmark completed successfully ===');
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`).run(new Date().toISOString(), runId);
		activeRun.emitter.emit('line', `\n[FATAL ERROR] ${msg}`);
	} finally {
		await pool.end().catch(() => {});
		completeRun(runId);
	}
}
