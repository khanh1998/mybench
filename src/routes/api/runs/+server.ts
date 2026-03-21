import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { createPool } from '$lib/server/pg-client';
import { collectSnapshot, getEnabledTablesForRun } from '$lib/server/pg-stats';
import { runPgbench, runSqlStep, type SqlStepOptions } from '$lib/server/pgbench';
import { createRun, completeRun, setPool, setSnapshotTimer, setActivePhase } from '$lib/server/run-manager';
import { substituteParams } from '$lib/server/params';
import type { RequestHandler } from './$types';
import type { PgServer, DesignStep, PgbenchScript, DesignParam } from '$lib/types';

export const GET: RequestHandler = ({ url }) => {
	const db = getDb();
	const designId = url.searchParams.get('design_id');
	const runs = designId
		? db.prepare('SELECT * FROM benchmark_runs WHERE design_id = ? ORDER BY id DESC').all(Number(designId))
		: db.prepare('SELECT * FROM benchmark_runs ORDER BY id DESC LIMIT 50').all();
	return json(runs);
};

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();
	const { design_id, server_id, database, snapshot_interval_seconds = 30 } = body;

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(design_id)) as {
		id: number; decision_id: number; name: string; server_id: number; database: string;
		pre_collect_secs: number; post_collect_secs: number;
	} | undefined;
	if (!design) throw error(404, 'Design not found');

	const resolvedServerId = server_id ?? design.server_id;
	const resolvedDatabase: string = database ?? design.database;

	const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(resolvedServerId) as PgServer | undefined;
	if (!server) throw error(400, 'Server not configured for this design');

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

	// Compute pre/post collect secs: from collect steps if present, else design defaults
	const hasCollectSteps = steps.some(s => s.type === 'collect');
	let preCollectSecs: number;
	let postCollectSecs: number;
	if (hasCollectSteps) {
		const firstPgbenchPos = steps.find(s => s.type === 'pgbench')?.position ?? Infinity;
		const lastPgbenchPos = [...steps].reverse().find(s => s.type === 'pgbench')?.position ?? -Infinity;
		preCollectSecs = steps.filter(s => s.type === 'collect' && s.position < firstPgbenchPos).reduce((sum, s) => sum + (s.duration_secs ?? 0), 0);
		postCollectSecs = steps.filter(s => s.type === 'collect' && s.position > lastPgbenchPos).reduce((sum, s) => sum + (s.duration_secs ?? 0), 0);
	} else {
		preCollectSecs = design.pre_collect_secs ?? 0;
		postCollectSecs = design.post_collect_secs ?? 0;
	}

	// Create run record
	const runResult = db.prepare(
		'INSERT INTO benchmark_runs (design_id, status, snapshot_interval_seconds, pre_collect_secs, post_collect_secs) VALUES (?, ?, ?, ?, ?)'
	).run(design.id, 'running', snapshot_interval_seconds, preCollectSecs, postCollectSecs);
	const runId = runResult.lastInsertRowid as number;

	// Create step result records
	const insertStepResult = db.prepare(
		`INSERT INTO run_step_results (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`
	);
	for (const step of steps) {
		insertStepResult.run(runId, step.id, step.position, step.name, step.type);
	}

	const activeRun = createRun(runId);

	// Helper: collect snapshots for a fixed duration
	async function collectForDuration(
		pool: import('pg').Pool,
		runId: number,
		tables: string[],
		phase: 'pre' | 'bench' | 'post',
		durationSecs: number,
		intervalSecs: number
	) {
		if (!tables.length) return;
		const end = Date.now() + durationSecs * 1000;
		do {
			await collectSnapshot(pool, runId, tables, phase);
			const wait = Math.min(intervalSecs * 1000, end - Date.now());
			if (wait > 0) await new Promise(r => setTimeout(r, wait));
		} while (Date.now() < end);
	}

	// Run asynchronously
	(async () => {
		const pool = createPool(server, resolvedDatabase);
		setPool(runId, pool);
		const enabledTables = getEnabledTablesForRun(server.id);

		try {
			// ── Legacy pre-collect (designs without collect steps) ─────────
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

			// ── Steps (collect / sql / pgbench inline) ────────────────────
			let seenPgbench = false;
			for (const step of steps) {
				const startedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
				db.prepare(`UPDATE run_step_results SET status='running', started_at=? WHERE run_id=? AND step_id=?`).run(startedAt, runId, step.id);
				activeRun.emitter.emit('step', { step_id: step.id, status: 'running', started_at: startedAt });
				activeRun.emitter.emit('line', `\n=== Step: ${step.name} (${step.type}) ===`);

				let stdout = '';
				let stderr = '';
				let exitCode: number | null = null;

				const onLine = (line: string, stream: 'stdout' | 'stderr') => {
					if (stream === 'stdout') stdout += line + '\n';
					else stderr += line + '\n';
				};

				if (step.type === 'collect') {
					// ── Collect step ──────────────────────────────────────
					const phase = seenPgbench ? 'post' : 'pre';
					const durationSecs = step.duration_secs ?? 0;
					if (durationSecs > 0 && enabledTables.length > 0) {
						const phaseObj = { name: phase as 'pre' | 'post', status: 'running' as const, duration_secs: durationSecs, started_ms: Date.now() };
						setActivePhase(runId, phaseObj);
						activeRun.emitter.emit('phase', phaseObj);
						activeRun.emitter.emit('line', `[snapshot] Collecting pg_stat_* for ${durationSecs}s...`);
						if (phase === 'post') {
							db.prepare(`UPDATE benchmark_runs SET post_started_at=? WHERE id=?`).run(new Date().toISOString(), runId);
						}
						await collectForDuration(pool, runId, enabledTables, phase, durationSecs, snapshot_interval_seconds);
						const phaseDone = { ...phaseObj, status: 'completed' as const };
						setActivePhase(runId, phase === 'post' ? null : phaseDone);
						activeRun.emitter.emit('phase', phaseDone);
					} else {
						activeRun.emitter.emit('line', durationSecs <= 0 ? '[snapshot] Duration is 0, skipping.' : '[snapshot] No tables enabled, skipping.');
					}
					exitCode = 0;
				} else if (step.type === 'pgbench') {
					// ── pgbench step ──────────────────────────────────────
					// Record bench_started_at on first pgbench step
					const benchStartedAt = new Date().toISOString();
					db.prepare(`UPDATE benchmark_runs SET bench_started_at=? WHERE id=? AND bench_started_at IS NULL`)
						.run(benchStartedAt, runId);
					seenPgbench = true;

					// Start periodic bench snapshots
					const timer = setInterval(async () => {
						await collectSnapshot(pool, runId, enabledTables, 'bench');
					}, snapshot_interval_seconds * 1000);
					setSnapshotTimer(runId, timer);

					let scripts = scriptsByStep.get(step.id) ?? [];
					if (scripts.length === 0 && step.script) {
						scripts = [{ id: step.id, name: 'script', weight: 1, script: step.script, step_id: step.id, position: 0 }];
					}
					const substitutedScripts = scripts.map(ps => ({
						...ps,
						script: substituteParams(ps.script, designParams)
					}));

					const result = await runPgbench(
						{
							host: server.host,
							port: server.port,
							user: server.username,
							password: server.password,
							database: resolvedDatabase,
							scripts: substitutedScripts,
							options: substituteParams(step.pgbench_options, designParams),
							runId,
							stepId: step.id
						},
						activeRun.emitter,
						onLine
					);

					clearInterval(timer);
					exitCode = result.exitCode;

					const pgbenchScript = substitutedScripts.map(ps => `-- [${ps.name} @${ps.weight}]\n${ps.script}`).join('\n\n');
					db.prepare(`UPDATE run_step_results SET command=?, processed_script=? WHERE run_id=? AND step_id=?`)
						.run(result.command, pgbenchScript, runId, step.id);

					// Final bench snapshot
					await collectSnapshot(pool, runId, enabledTables, 'bench');

					if (result.tps !== null) {
						db.prepare(
							`UPDATE benchmark_runs SET tps=?, latency_avg_ms=?, latency_stddev_ms=?, transactions=? WHERE id=?`
						).run(result.tps, result.latencyAvgMs, result.latencyStddevMs, result.transactions, runId);
					}
				} else {
					// ── SQL step ──────────────────────────────────────────
					const sqlOpts: SqlStepOptions = {
						host: server.host,
						port: server.port,
						user: server.username,
						password: server.password,
						database: resolvedDatabase
					};
					const processedSqlScript = substituteParams(step.script, designParams);
					const result = await runSqlStep(sqlOpts, processedSqlScript, activeRun.emitter, onLine, !!step.no_transaction);
					exitCode = result.exitCode;
					db.prepare(`UPDATE run_step_results SET command=?, processed_script=? WHERE run_id=? AND step_id=?`)
						.run(result.command, processedSqlScript, runId, step.id);
				}

				const stepStatus = exitCode === 0 ? 'completed' : 'failed';
				const finishedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
				db.prepare(
					`UPDATE run_step_results SET status=?, stdout=?, stderr=?, exit_code=?, finished_at=? WHERE run_id=? AND step_id=?`
				).run(stepStatus, stdout, stderr, exitCode, finishedAt, runId, step.id);
				activeRun.emitter.emit('step', { step_id: step.id, status: stepStatus, finished_at: finishedAt });

				if (stepStatus === 'failed') {
					activeRun.emitter.emit('line', `\n[ERROR] Step "${step.name}" failed with exit code ${exitCode}. Stopping.`);
					db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=datetime('now') WHERE id=?`).run(runId);
					return;
				}
			}

			// ── Legacy post-collect (designs without collect steps) ────────
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

			db.prepare(`UPDATE benchmark_runs SET status='completed', finished_at=datetime('now') WHERE id=?`).run(runId);
			activeRun.emitter.emit('line', '\n=== Benchmark completed successfully ===');
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=datetime('now') WHERE id=?`).run(runId);
			activeRun.emitter.emit('line', `\n[FATAL ERROR] ${msg}`);
		} finally {
			await pool.end().catch(() => {});
			completeRun(runId);
		}
	})();

	return json({ run_id: runId }, { status: 201 });
};
