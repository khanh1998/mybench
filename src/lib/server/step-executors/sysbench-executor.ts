import getDb from '$lib/server/db';
import { collectSnapshot, collectPgLocksSnapshot } from '$lib/server/pg-stats';
import { setSnapshotTimer } from '$lib/server/run-manager';
import { substituteParams } from '$lib/server/params';
import { runSysbench } from '$lib/server/sysbench';
import type { StepContext, StepResult } from './types';

export async function executeSysbenchStep(ctx: StepContext): Promise<StepResult> {
	const { step, runId, server, resolvedDatabase, resolvedParams, pool, enabledTables, snapshotIntervalSecs, activeRun, onLine } = ctx;
	const db = getDb();

	db.prepare(`UPDATE benchmark_runs SET bench_started_at=? WHERE id=? AND bench_started_at IS NULL`)
		.run(new Date().toISOString(), runId);

	const timer = setInterval(async () => {
		await collectSnapshot(pool, runId, enabledTables, 'bench');
		await collectPgLocksSnapshot(pool, runId, 'bench');
	}, snapshotIntervalSecs * 1000);
	setSnapshotTimer(runId, timer);

	const script = substituteParams(step.script ?? '', resolvedParams);
	const options = substituteParams(step.pgbench_options ?? '', resolvedParams);

	const result = await runSysbench(
		{
			host: server.host,
			port: server.port,
			user: server.username,
			password: server.password,
			database: resolvedDatabase,
			script,
			options,
			runId,
			stepId: step.id,
		},
		activeRun.emitter,
		onLine
	);

	clearInterval(timer);

	db.prepare(`
		UPDATE run_step_results
		SET command=?, processed_script=?, sysbench_summary_json=?
		WHERE run_id=? AND step_id=?
	`).run(
		result.command,
		script,
		result.sysbenchSummary ? JSON.stringify(result.sysbenchSummary) : '',
		runId,
		step.id
	);

	await collectSnapshot(pool, runId, enabledTables, 'bench');
	await collectPgLocksSnapshot(pool, runId, 'bench');

	if (result.tps !== null) {
		db.prepare(`UPDATE benchmark_runs SET tps=?, latency_avg_ms=?, transactions=? WHERE id=?`)
			.run(result.tps, result.latencyAvgMs, result.transactions, runId);
	}

	return { exitCode: result.exitCode };
}
