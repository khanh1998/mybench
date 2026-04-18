import getDb from '$lib/server/db';
import { collectSnapshot, collectPgLocksSnapshot } from '$lib/server/pg-stats';
import { setSnapshotTimer } from '$lib/server/run-manager';
import { getRunnablePgbenchScripts, resolveScriptWeight } from '$lib/params';
import { formatProcessedPgbenchScripts } from '$lib/pgbench-results';
import { runPgbench } from '$lib/server/pgbench';
import { substituteParams } from '$lib/server/params';
import type { StepContext, StepResult } from './types';

export async function executePgbenchStep(ctx: StepContext): Promise<StepResult> {
	const { step, runId, server, resolvedDatabase, resolvedParams, pool, enabledTables, snapshotIntervalSecs, activeRun, onLine, logStepLine, scriptsByStep } = ctx;
	const db = getDb();

	db.prepare(`UPDATE benchmark_runs SET bench_started_at=? WHERE id=? AND bench_started_at IS NULL`)
		.run(new Date().toISOString(), runId);

	const timer = setInterval(async () => {
		await collectSnapshot(pool, runId, enabledTables, 'bench');
		await collectPgLocksSnapshot(pool, runId, 'bench');
	}, snapshotIntervalSecs * 1000);
	setSnapshotTimer(runId, timer);

	let scripts = scriptsByStep.get(step.id) ?? [];
	if (scripts.length === 0 && step.script) {
		scripts = [{ id: step.id, name: 'script', weight: 1, weight_expr: null, script: step.script, step_id: step.id, position: 0 }];
	}
	const runnableScripts = getRunnablePgbenchScripts(scripts);
	if (scripts.length > 0 && runnableScripts.length === 0) {
		logStepLine('[pgbench] All custom scripts have weight 0. Running pgbench built-in scenario.');
	} else if (runnableScripts.length < scripts.length) {
		logStepLine(`[pgbench] Ignoring ${scripts.length - runnableScripts.length} script(s) with weight 0.`);
	}

	const substitutedScripts = runnableScripts
		.map(ps => ({
			...ps,
			weight: resolveScriptWeight(ps, resolvedParams),
			script: substituteParams(ps.script, resolvedParams)
		}))
		.filter(ps => ps.weight > 0);

	const result = await runPgbench(
		{
			host: server.host,
			port: server.port,
			user: server.username,
			password: server.password,
			database: resolvedDatabase,
			scripts: substitutedScripts,
			options: substituteParams(step.pgbench_options, resolvedParams),
			runId,
			stepId: step.id
		},
		activeRun.emitter,
		onLine
	);

	clearInterval(timer);

	const pgbenchScript = formatProcessedPgbenchScripts(substitutedScripts);
	const pgbenchScriptsJson = substitutedScripts.length > 0
		? JSON.stringify(substitutedScripts.map((script, index) => {
			const parsedScript = result.pgbenchScripts.find((item) => item.position === index);
			return {
				position: index,
				name: script.name,
				weight: script.weight,
				script: script.script,
				tps: parsedScript?.tps ?? null,
				latency_avg_ms: parsedScript?.latency_avg_ms ?? null,
				latency_stddev_ms: parsedScript?.latency_stddev_ms ?? null,
				transactions: parsedScript?.transactions ?? null,
				failed_transactions: parsedScript?.failed_transactions ?? null
			};
		}))
		: '';

	db.prepare(`
		UPDATE run_step_results
		SET command=?, processed_script=?, pgbench_summary_json=?, pgbench_scripts_json=?
		WHERE run_id=? AND step_id=?
	`).run(
		result.command,
		pgbenchScript,
		result.pgbenchSummary ? JSON.stringify(result.pgbenchSummary) : '',
		pgbenchScriptsJson,
		runId,
		step.id
	);

	await collectSnapshot(pool, runId, enabledTables, 'bench');
	await collectPgLocksSnapshot(pool, runId, 'bench');

	if (result.tps !== null) {
		db.prepare(`UPDATE benchmark_runs SET tps=?, latency_avg_ms=?, latency_stddev_ms=?, transactions=? WHERE id=?`)
			.run(result.tps, result.latencyAvgMs, result.latencyStddevMs, result.transactions, runId);
	}

	return { exitCode: result.exitCode };
}
