import getDb from '$lib/server/db';
import { runSqlStep, type SqlStepOptions } from '$lib/server/pgbench';
import { substituteParams } from '$lib/server/params';
import type { StepContext, StepResult } from './types';

export async function executeSqlStep(ctx: StepContext): Promise<StepResult> {
	const { step, runId, server, resolvedDatabase, resolvedParams, activeRun, onLine } = ctx;
	const db = getDb();

	const sqlOpts: SqlStepOptions = {
		host: server.host,
		port: server.port,
		user: server.username,
		password: server.password,
		database: resolvedDatabase
	};
	const processedSqlScript = substituteParams(step.script, resolvedParams);
	const result = await runSqlStep(sqlOpts, processedSqlScript, activeRun.emitter, onLine, !!step.no_transaction);

	db.prepare(`UPDATE run_step_results SET command=?, processed_script=? WHERE run_id=? AND step_id=?`)
		.run(result.command, processedSqlScript, runId, step.id);

	return { exitCode: result.exitCode };
}
