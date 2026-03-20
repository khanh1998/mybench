export interface PgServer {
	id: number;
	name: string;
	host: string;
	port: number;
	username: string;
	password: string;
	ssl: number; // 0 or 1
}

export interface PgStatTableSelection {
	server_id: number;
	table_name: string;
	enabled: number; // 0 or 1
}

export interface Decision {
	id: number;
	name: string;
	description: string;
}

export interface Design {
	id: number;
	decision_id: number;
	name: string;
	description: string;
	server_id: number;
	database: string;
}

export interface PgbenchScript {
	id: number;
	step_id: number;
	position: number;
	name: string;
	weight: number;
	script: string;
}

export interface DesignParam {
	id: number;
	design_id: number;
	position: number;
	name: string;
	value: string;
}

export interface DesignStep {
	id: number;
	design_id: number;
	position: number;
	name: string;
	type: 'sql' | 'pgbench';
	script: string;
	pgbench_options: string;
	enabled: number; // 0 or 1
	pgbench_scripts?: PgbenchScript[];
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface BenchmarkRun {
	id: number;
	design_id: number;
	status: RunStatus;
	started_at: string;
	finished_at: string | null;
	snapshot_interval_seconds: number;
	tps: number | null;
	latency_avg_ms: number | null;
	latency_stddev_ms: number | null;
	transactions: number | null;
}

export interface RunStepResult {
	id: number;
	run_id: number;
	step_id: number;
	position: number;
	name: string;
	type: 'sql' | 'pgbench';
	status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
	stdout: string;
	stderr: string;
	exit_code: number | null;
	started_at: string | null;
	finished_at: string | null;
}

export interface SavedQuery {
	id: number;
	decision_id: number | null;
	name: string;
	sql: string;
}
