import { resetPgStatStatements, collectPgStatStatementsSnapshot } from '$lib/server/pg-stats';
import type { StepContext, StepResult } from './types';

export async function executePgStatStatementsResetStep(ctx: StepContext): Promise<StepResult> {
	const { pool, logStepLine } = ctx;
	logStepLine('[pg_stat_statements] Resetting query stats...');
	const result = await resetPgStatStatements(pool);
	if (result.warning) {
		logStepLine(`[warning] ${result.warning}`, 'stderr');
	} else {
		logStepLine('[pg_stat_statements] Reset complete.');
	}
	return { exitCode: 0 };
}

export async function executePgStatStatementsCollectStep(ctx: StepContext): Promise<StepResult> {
	const { pool, runId, step, logStepLine } = ctx;
	logStepLine('[pg_stat_statements] Collecting query stats snapshot...');
	const result = await collectPgStatStatementsSnapshot(pool, runId, step.id);
	if (result.warning) {
		logStepLine(`[warning] ${result.warning}`, 'stderr');
	} else {
		logStepLine(`[pg_stat_statements] Stored ${result.rowCount} row(s) for the current database.`);
	}
	return { exitCode: 0 };
}
