export type DesignStepType =
	| 'sql'
	| 'pgbench'
	| 'collect'
	| 'pg_stat_statements_reset'
	| 'pg_stat_statements_collect';

export interface PgServer {
	id: number;
	name: string;
	host: string;
	port: number;
	username: string;
	password: string;
	ssl: number; // 0 or 1
	rds_instance_id: string;
	aws_region: string;
	enhanced_monitoring: number; // 0 or 1
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
	weight_expr: string | null;
	script: string;
}

export interface PgbenchStepSummary {
	tps: number | null;
	latency_avg_ms: number | null;
	latency_stddev_ms: number | null;
	transactions: number | null;
	failed_transactions: number | null;
	transaction_type?: string | null;
	scaling_factor?: number | null;
	query_mode?: string | null;
	number_of_clients?: number | null;
	number_of_threads?: number | null;
	maximum_tries?: number | null;
	duration_secs?: number | null;
	initial_connection_time_ms?: number | null;
}

export interface PgbenchScriptResult {
	position: number;
	name: string;
	weight: number | null;
	script: string;
	tps: number | null;
	latency_avg_ms: number | null;
	latency_stddev_ms: number | null;
	transactions: number | null;
	failed_transactions: number | null;
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
	type: DesignStepType;
	script: string;
	pgbench_options: string;
	duration_secs: number;
	no_transaction: number; // 0 or 1 — SQL steps only: omit --single-transaction
	enabled: number; // 0 or 1
	pgbench_scripts?: PgbenchScript[];
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'pending';

export interface BenchmarkRun {
	id: number;
	design_id: number;
	database: string;
	status: RunStatus;
	started_at: string;
	finished_at: string | null;
	snapshot_interval_seconds: number;
	tps: number | null;
	latency_avg_ms: number | null;
	latency_stddev_ms: number | null;
	transactions: number | null;
	name: string;
	notes: string;
	profile_name: string;
	run_params: string; // JSON string of [{name, value}]; '' if no params
	is_imported: number;          // 0 or 1
	ec2_server_id: number | null;
	ec2_run_token: string | null;
	series_id: number | null;
}

export interface BenchmarkSeries {
	id: number;
	design_id: number;
	name: string;
	delay_seconds: number;
	status: 'running' | 'completed' | 'failed';
	ec2_run_token: string | null;
	created_at: string;
	finished_at: string | null;
}

export interface ParamProfile {
	id: number;
	design_id: number;
	name: string;
	values: { param_name: string; value: string }[];
}

export interface RunStepResult {
	id: number;
	run_id: number;
	step_id: number;
	position: number;
	name: string;
	type: DesignStepType;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
	stdout: string;
	stderr: string;
	exit_code: number | null;
	started_at: string | null;
	finished_at: string | null;
	command: string;
	processed_script: string;
	pgbench_summary_json: string;
	pgbench_scripts_json: string;
}

export interface Ec2Server {
	id: number;
	name: string;
	host: string;
	user: string;        // SSH username
	port: number;        // SSH port (default 22)
	private_key: string; // PEM content of SSH private key (stored in DB, not a file path)
	remote_dir: string;  // working directory on EC2
	log_dir: string;     // pgbench log directory on EC2
}

export interface SavedQuery {
	id: number;
	decision_id: number | null;
	name: string;
	sql: string;
}
