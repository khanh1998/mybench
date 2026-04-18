import type pg from 'pg';
import type { DesignStep, PgServer, DesignParam, PgbenchScript } from '$lib/types';
import type { ActiveRun } from '$lib/server/run-manager';

export interface StepContext {
	step: DesignStep;
	runId: number;
	server: PgServer;
	resolvedDatabase: string;
	resolvedParams: DesignParam[];
	pool: pg.Pool;
	enabledTables: string[];
	snapshotIntervalSecs: number;
	activeRun: ActiveRun;
	onLine: (line: string, stream: 'stdout' | 'stderr') => void;
	logStepLine: (line: string, stream?: 'stdout' | 'stderr') => void;
	scriptsByStep: Map<number, PgbenchScript[]>;
	seenBench: boolean;
}

export interface StepResult {
	exitCode: number | null;
}
