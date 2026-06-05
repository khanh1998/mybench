export type DesignStepType =
	| 'sql'
	| 'pgbench'
	| 'sysbench'
	| 'collect'
	| 'pg_stat_statements_reset'
	| 'pg_stat_statements_collect'
	| 'perf'
	| 'pg_stat'
	| 'proc';

export interface PgServer {
	id: number;
	name: string;
	host: string;
	port: number;
	username: string;
	password: string;
	ssl: number; // 0 or 1
	ssh_enabled: number; // 0 or 1
	ssh_host: string | null; // null = fall back to host
	ssh_port: number;
	ssh_user: string | null;
	ssh_private_key: string | null;
	private_host: string; // optional private/VPC IP for runner→PG communication
	vpc: string;          // VPC name tag; matched against Ec2Server.vpc to auto-enable private_host
	spec?: string;        // free-text instance hardware description
	pg_config?: string;   // optional freeform PostgreSQL config notes
	perf_enabled: number; // 0 or 1
	perf_scope: 'postgres_cgroup' | 'system' | 'disabled';
	perf_cgroup: string;
	perf_events: string;
	perf_status_json: string;
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
	collect_perf: number; // 0 or 1 — pgbench/sysbench steps only
	perf_duration: string; // seconds expression; supports {{PARAM}} placeholders
	perf_stat_duration: string;
	perf_record_duration: string;
	perf_trace_duration: string;
	perf_stat_enabled: number;
	perf_record_enabled: number;
	perf_trace_enabled: number;
	perf_delay: string; // seconds before sampling starts; supports {{PARAM}} placeholders
	perf_stat_delay: string;
	perf_record_delay: string;
	perf_trace_delay: string;
	perf_mode: 'stat' | 'record' | 'trace';
	perf_cgroup: string;
	perf_events: string;
	perf_repeat: string;
	perf_freq: string;
	perf_call_graph: 'dwarf' | 'fp' | 'lbr';
	perf_mmap_pages: string;
	enabled: number; // 0 or 1
	pgbench_scripts?: PgbenchScript[];
	// pg_stat step fields
	pg_stat_tables: string;              // JSON array of table names, '' or '[]' = all available
	pg_stat_interval_seconds: string;    // TEXT, supports {{PARAM}}
	pg_stat_pg_locks_enabled: number;    // 0 | 1
	pg_stat_pg_locks_interval: string;   // TEXT, supports {{PARAM}}, empty = use snap interval
	pg_stat_reset_stats: number;         // 0 | 1 — fires pg_stat_reset()
	pg_stat_reset_statements: number;    // 0 | 1 — fires pg_stat_statements_reset()
	pg_stat_pss_track_planning: number;  // 0 | 1 — ALTER SYSTEM SET pg_stat_statements.track_planning = on
	pg_stat_collect_statements: number;  // 0 | 1 — collect pg_stat_statements at bench end
	// proc step fields
	proc_groups: string;           // JSON array of group names, '' or '[]' = all groups
	proc_interval_seconds: string; // TEXT, supports {{PARAM}}, empty = use snapshot interval
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
	runner_spec: string;
	db_spec: string;
	db_pg_config: string;
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

export interface DecisionParam {
	id: number;
	decision_id: number;
	position: number;
	name: string;
	value: string;
}

export interface DecisionParamProfile {
	id: number;
	decision_id: number;
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
	sysbench_summary_json: string;
}

export interface RunStepPerfEvent {
	id: number;
	run_id: number;
	step_id: number;
	event_name: string;
	counter_value: number | null;
	unit: string;
	runtime_secs: number | null;
	percent_running: number | null;
	per_transaction: number | null;
	derived_value: number | null;
	derived_unit: string;
}

export interface RunStepPerf {
	id: number;
	run_id: number;
	step_id: number;
	mode: 'stat' | 'record' | 'trace';
	status: string;
	scope: 'postgres_cgroup' | 'system' | 'disabled';
	cgroup: string;
	command: string;
	raw_output: string;
	raw_error: string;
	result_json: string;
	perf_script_output: string;
	warnings_json: string;
	started_at: string | null;
	finished_at: string | null;
	events: RunStepPerfEvent[];
}

export interface Ec2Server {
	id: number;
	name: string;
	host: string;
	user: string;        // SSH username
	port: number;        // SSH port (default 22)
	private_key: string; // PEM content of SSH private key (stored in DB, not a file path)
	remote_dir: string;    // working directory on EC2
	log_dir: string;       // pgbench log directory on EC2
	cli_log_dir: string;   // directory on VPS for persistent Go CLI stderr logs
	vpc: string;           // VPC name tag; matched against PgServer.vpc to auto-enable private_host
	spec?: string;         // free-text instance hardware description
}

export interface SavedQuery {
	id: number;
	decision_id: number | null;
	name: string;
	sql: string;
}
