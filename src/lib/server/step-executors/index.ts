import type { DesignStepType } from '$lib/types';
import type { StepContext, StepResult } from './types';
import { executePgbenchStep } from './pgbench-executor';
import { executeSysbenchStep } from './sysbench-executor';
import { executeSqlStep } from './sql-executor';
import { executeCollectStep } from './collect-executor';
import { executePgStatStatementsResetStep, executePgStatStatementsCollectStep } from './pg-stat-executor';

export type { StepContext, StepResult };

export const BENCH_STEP_TYPES: DesignStepType[] = ['pgbench', 'sysbench'];

const EXECUTORS: Record<string, (ctx: StepContext) => Promise<StepResult>> = {
	pgbench: executePgbenchStep,
	sysbench: executeSysbenchStep,
	sql: executeSqlStep,
	collect: executeCollectStep,
	pg_stat_statements_reset: executePgStatStatementsResetStep,
	pg_stat_statements_collect: executePgStatStatementsCollectStep,
};

export function getStepExecutor(type: string): (ctx: StepContext) => Promise<StepResult> {
	const exec = EXECUTORS[type];
	if (!exec) throw new Error(`Unknown step type: ${type}`);
	return exec;
}
