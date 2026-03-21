import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { createPool } from '$lib/server/pg-client';
import { collectSnapshot, getEnabledTablesForRun } from '$lib/server/pg-stats';
import { runPgbench, runSqlStep, type SqlStepOptions } from '$lib/server/pgbench';
import { createRun, completeRun, setPool, setSnapshotTimer } from '$lib/server/run-manager';
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

	// Create run record
	const runResult = db.prepare(
		'INSERT INTO benchmark_runs (design_id, status, snapshot_interval_seconds) VALUES (?, ?, ?)'
	).run(design.id, 'running', snapshot_interval_seconds);
	const runId = runResult.lastInsertRowid as number;

	// Create step result records
	const insertStepResult = db.prepare(
		`INSERT INTO run_step_results (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`
	);
	for (const step of steps) {
		insertStepResult.run(runId, step.id, step.position, step.name, step.type);
	}

	const activeRun = createRun(runId);

	// Run asynchronously
	(async () => {
		const pool = createPool(server, resolvedDatabase);
		setPool(runId, pool);
		const enabledTables = getEnabledTablesForRun(server.id);

		try {
			for (const step of steps) {
				// Mark step as running
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

				if (step.type === 'pgbench') {
					// Take baseline snapshot
					activeRun.emitter.emit('line', '[snapshot] Taking baseline snapshot...');
					await collectSnapshot(pool, runId, enabledTables, true);

					// Start periodic snapshots
					const timer = setInterval(async () => {
						await collectSnapshot(pool, runId, enabledTables, false);
					}, snapshot_interval_seconds * 1000);
					setSnapshotTimer(runId, timer);

					// Load scripts for this step (fallback for unmigrated steps)
					let scripts = scriptsByStep.get(step.id) ?? [];
					if (scripts.length === 0 && step.script) {
						scripts = [{ id: step.id, name: 'script', weight: 1, script: step.script, step_id: step.id, position: 0 }];
					}

					// Apply param substitution to all scripts
					const substitutedScripts = scripts.map(ps => ({
						...ps,
						script: substituteParams(ps.script, designParams)
					}));

					// Run pgbench
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

					// Save command + processed script
					const pgbenchScript = substitutedScripts.map(ps => `-- [${ps.name} @${ps.weight}]\n${ps.script}`).join('\n\n');
					db.prepare(`UPDATE run_step_results SET command=?, processed_script=? WHERE run_id=? AND step_id=?`)
						.run(result.command, pgbenchScript, runId, step.id);

					// Final snapshot
					activeRun.emitter.emit('line', '[snapshot] Taking final snapshot...');
					await collectSnapshot(pool, runId, enabledTables, false);

					// Update run stats
					if (result.tps !== null) {
						db.prepare(
							`UPDATE benchmark_runs SET tps=?, latency_avg_ms=?, latency_stddev_ms=?, transactions=? WHERE id=?`
						).run(result.tps, result.latencyAvgMs, result.latencyStddevMs, result.transactions, runId);
					}
				} else {
					// SQL step — run via psql CLI so \echo, \set, \if etc. all work
					const sqlOpts: SqlStepOptions = {
						host: server.host,
						port: server.port,
						user: server.username,
						password: server.password,
						database: resolvedDatabase
					};
					const processedSqlScript = substituteParams(step.script, designParams);
					const result = await runSqlStep(sqlOpts, processedSqlScript, activeRun.emitter, onLine);
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
