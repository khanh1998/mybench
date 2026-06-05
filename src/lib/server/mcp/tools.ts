import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRunnablePgbenchScripts } from '$lib/params';
import getDb from '$lib/server/db';
import { createPool } from '$lib/server/pg-client';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import { startEc2Run } from '$lib/server/ec2-executor';
import type { PgServer, Ec2Server, DesignStep, PgbenchScript, DesignParam } from '$lib/types';
import {
	deleteEc2Server,
	listEc2Servers,
	saveEc2Server,
	testEc2Server
} from '$lib/server/services/ec2-servers';
import {
	deletePgServer,
	listPgServers,
	savePgServer,
	testPgServer
} from '$lib/server/services/pg-servers';

const EXCLUDED_SNAP_COLS = new Set(['_id', '_run_id', '_collected_at', '_phase', '_is_baseline', '_step_id']);

function text(obj: unknown): { content: [{ type: 'text'; text: string }] } {
	return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

function scrubPgServer(server: PgServer) {
	return {
		id: server.id,
		name: server.name,
		host: server.host,
		port: server.port,
		username: server.username,
		ssl: !!server.ssl
	};
}

function scrubEc2Server(server: Ec2Server) {
	return {
		id: server.id,
		name: server.name,
		host: server.host,
		user: server.user,
		port: server.port,
		remote_dir: server.remote_dir,
		log_dir: server.log_dir
	};
}

export function registerTools(server: McpServer): void {
	// ─────────────────────────────────────────────────────────────────────────
	// get_context
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'get_context',
		{
			description: `Returns a complete guide to mybench. Call this first before using any other tool.
Covers: data model, database servers, step types, {{PARAM}} syntax, pgbench script format,
and the recommended workflow for creating and running a benchmark plan.`
		},
		async () => {
			const db = getDb();
			const servers = db.prepare('SELECT id, name, host, port, username, ssl FROM pg_servers ORDER BY id').all() as {
				id: number; name: string; host: string; port: number; username: string; ssl: number;
			}[];
			const ec2Servers = db.prepare('SELECT id, name, host, user, port FROM ec2_servers ORDER BY id').all() as {
				id: number; name: string; host: string; user: string; port: number;
			}[];

			const guide = {
				overview: 'mybench helps you design and run PostgreSQL benchmarks. Use these tools to create plans, run tests, and export results.',
				database_servers: servers.length > 0
					? servers.map(s => ({ id: s.id, name: s.name, host: s.host, port: s.port, username: s.username, ssl: !!s.ssl }))
					: 'No servers configured yet. Add one in Settings (http://localhost:5173/settings) before running benchmarks.',
				ec2_servers: ec2Servers.length > 0
					? ec2Servers.map(s => ({ id: s.id, name: s.name, host: s.host, user: s.user, port: s.port }))
					: 'No EC2 runners configured yet. Add one in Settings (http://localhost:5173/settings) before using remote runs.',
				data_model: {
					decisions: 'Top-level question you are answering (e.g. "Which table design is faster?"). Contains one or more designs. Can define shared decision-level params and profiles.',
					designs: 'One candidate design to benchmark (e.g. "plain table" vs "partitioned table"). Each design is linked to a database server and has steps + params. Inherits all decision-level params and profiles.',
					steps: 'Ordered list of actions: sql setup → pgbench or sysbench load test → sql teardown. Optionally add a pg_stat step (snapshot config, position irrelevant — see step_types.pg_stat) and a proc step (host metrics config, same). Add a proc step for OS host metrics.',
					params: 'Named values (e.g. NUM_USERS=1000) substituted as {{NAME}} in step scripts and pgbench_options. Two levels — choose based on scope: DECISION-LEVEL (set_decision_params): use for any value that is the same across multiple designs, or that you may want to change in one place and have it affect all designs at once (e.g. NUM_CLIENTS, DURATION_SECS, NUM_ROWS, SNAPSHOT_INTERVAL, TRANSFER_WEIGHT). This is the default choice for most params. DESIGN-LEVEL (set_params): use only for values that intentionally differ between designs (e.g. a design-specific index hint or a table name that varies per candidate). Rule of thumb: if you find yourself setting the same param name to the same value in multiple designs, move it to the decision level.',
					profiles: 'Named sets of param overrides (e.g. "small"=NUM_USERS:100, "large"=NUM_USERS:10000) for running the same design at different scales. Two levels: (1) decision-level profiles managed on the decision screen — used exclusively in suite runs; (2) design-level profiles managed with upsert_profile/list_profiles/delete_profile — used in single and series runs. Both levels are available in the profile picker for single/series runs (design wins).',
					param_inheritance: 'Effective params for a design = decision params merged with design params (design wins on the same name). Practical implication: put shared config at the decision level so changing one value propagates to every design automatically — you never have to visit each design individually. Only put a param at the design level when that design genuinely needs a different value from the others. Suite runs use ONLY decision-level params and profiles (design-level params are ignored); single/series runs merge both levels.',
					suite_vs_single: 'Suite run (POST /api/suites): uses ONLY decision-level params and decision-level profiles — pass decision_profile_ids per design. Single run (run_design / POST /api/runs): uses merged params; profile_id refers to a design-level profile by default, pass profile_source="decision" to use a decision-level profile.'
				},
				step_types: {
					proc: {
						description: 'Collects Linux /proc host metrics from the database server via SSH during the benchmark. Configuration-only step — actual collection starts when the pgbench/sysbench step begins. Not supported for managed databases (RDS, Cloud SQL).',
						fields: {
							type: '"proc"',
							name: 'string',
							position: 'integer (does not affect execution order — collection always wraps the bench step)',
							proc_groups: [
								'JSON array of /proc group keys to collect. Empty array = all groups. Pass a subset to reduce noise.',
								'System-level groups (reads from the paths shown):',
								'  "loadavg"    — /proc/loadavg          — 1/5/15-min load averages, running and total thread counts',
								'  "meminfo"    — /proc/meminfo          — MemFree, MemAvailable, Cached, Dirty, SwapUsed, HugePages',
								'  "stat"       — /proc/stat             — per-CPU user/sys/iowait/steal ticks, context switches, interrupts',
								'  "vmstat"     — /proc/vmstat           — page faults, pgpgin/pgpgout, swap in/out, dirty pages, writeback',
								'  "diskstats"  — /proc/diskstats        — read/write IOPS, sectors, and queue time per block device',
								'  "net_dev"    — /proc/net/dev          — rx/tx bytes, packets, errors, and drops per network interface',
								'  "schedstat"  — /proc/schedstat        — per-CPU run time, wait time, and timeslices (scheduler stats)',
								'  "pressure"   — /proc/pressure/        — PSI some/full avg10/avg60/avg300 for CPU, memory, and I/O',
								'  "file_nr"    — /proc/sys/fs/file-nr   — system-wide allocated and maximum file descriptor count',
								'Per-process groups (scoped to the postgres process PID):',
								'  "pid_stat"       — /proc/[pid]/stat      — state, utime, stime, minflt, majflt, vsize, rss, num_threads',
								'  "pid_statm"      — /proc/[pid]/statm     — size, resident, shared, text, data pages',
								'  "pid_io"         — /proc/[pid]/io        — rchar, wchar, read_bytes, write_bytes, cancelled_write_bytes',
								'  "pid_schedstat"  — /proc/[pid]/schedstat — run_time_ns, wait_time_ns, timeslices',
								'  "pid_wchan"      — /proc/[pid]/wchan     — kernel function the process is sleeping in',
								'  "pid_fd"         — /proc/[pid]/fd        — open file descriptor count',
								'  "pid_status"     — /proc/[pid]/status    — VmPeak, VmRSS, VmSwap, Threads, voluntary/involuntary context switches',
								'Recommended minimal set: ["loadavg","meminfo","stat","diskstats","pid_stat","pid_io"]',
								'Placeholder example: \'["loadavg","meminfo","stat","diskstats","pid_stat","pid_io"]\''
							],
							proc_interval_seconds: 'Collection interval in seconds. Supports {{PARAM}}. Empty = use the design\'s snapshot_interval_seconds (default 30). Use "1" for high-resolution CPU/disk sampling; "5"–"10" for lighter overhead. Placeholder example: "30 or {{INTERVAL}} — leave empty to use run default"',
							enabled: 'boolean'
						},
						note: 'Requires ssh_enabled=true and SSH credentials on the PostgreSQL server record (Settings → PG Servers). Results stored in host_snap_* tables (one per group) queryable via query_run_data.'
					},
					sql: {
						description: 'Runs a SQL script via psql. Use for CREATE TABLE, INSERT seed data, DROP TABLE, etc.',
						fields: {
							type: '"sql"',
							name: 'string',
							position: 'integer (execution order, 0-based)',
							script: 'SQL text (supports {{PARAM}})',
							no_transaction: 'boolean — if true, omit the --single-transaction wrapper',
							enabled: 'boolean'
						}
					},
					pgbench: {
						description: 'Runs a pgbench load test. Measures TPS, latency, and transactions.',
						fields: {
							type: '"pgbench"',
							name: 'string',
							position: 'integer',
							pgbench_options: 'e.g. "-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum --protocol=prepared"',
							pgbench_scripts: 'array of {name, weight, weight_expr?, script} — pgbench custom script language (\\set, BEGIN, SQL, END). weight is a fixed integer controlling transaction mix (e.g. weight=30 out of total=100 → ~30% of transactions; all weights must sum to ≤ 100). weight_expr is a string that supports {{PARAM}} substitution (e.g. "{{TRANSFER_WEIGHT}}") — it overrides weight when set, and is resolved at run time from decision-level or design-level params. Use weight_expr when you want to control the transaction mix ratio via a shared decision param across multiple designs.',
							enabled: 'boolean'
						},
						note: 'Supports {{PARAM}} substitution in pgbench_options and in each pgbench script.'
					},
					sysbench: {
						description: 'Runs a sysbench load test using a Lua script. Better than pgbench for custom workloads like variable batch inserts, because Lua allows dynamic payload generation (--batch-size, per-thread state, etc.). Measures TPS, p95 latency, and errors. NOTE: executor is currently a stub — implementation pending.',
						fields: {
							type: '"sysbench"',
							name: 'string',
							position: 'integer',
							script: 'Lua script content (written to a temp file and passed to sysbench run)',
							pgbench_options: 'sysbench CLI flags, e.g. "--threads={{NUM_CLIENTS}} --time=60 --batch-size={{BATCH_SIZE}}" (reuses this column until a dedicated column is added)',
							enabled: 'boolean'
						},
						note: 'Supports {{PARAM}} substitution in script and pgbench_options. pg_stat_* snapshots wrap the run identically to pgbench.'
					},
					pg_stat: {
						description: 'CONFIGURATION-ONLY step — tells mybench which PostgreSQL statistics to collect and how often. It does NOT execute in sequence with other steps. The runner automatically takes snapshots BEFORE, DURING (on pg_stat_interval_seconds), and AFTER the pgbench/sysbench step, regardless of where this step appears in the list. DO NOT place it after pgbench hoping to "collect after the bench" — position is completely irrelevant to when collection happens. One pg_stat step per design is sufficient. NOTE: this step is unrelated to the pg_stat_statements PostgreSQL extension — to capture per-query stats, set pg_stat_collect_statements=true or add "pg_stat_statements" to pg_stat_tables.',
						fields: {
							type: '"pg_stat"',
							name: 'string',
							position: 'integer — has NO effect on execution order. Collection always wraps the bench step automatically. Any position value works; convention is to place it before the bench step for readability only.',
							pg_stat_tables: [
								'JSON array of PostgreSQL view names to snapshot on every interval. Empty array = all supported tables (recommended unless you need to reduce noise).',
								'Available view names:',
								'  "pg_stat_database"         — per-database transactions, cache hit rate, conflicts, deadlocks, temp files',
								'  "pg_stat_bgwriter"         — background writer buffers written, checkpoints requested',
								'  "pg_stat_checkpointer"     — checkpoint timing and buffers written (PG16+)',
								'  "pg_stat_user_tables"      — per-table seq/index scans, rows inserted/updated/deleted, live/dead tuples, autovacuum',
								'  "pg_stat_user_indexes"     — per-index scans and tuples fetched',
								'  "pg_statio_user_tables"    — per-table heap/index/toast block hits and reads (buffer pool vs disk)',
								'  "pg_statio_user_indexes"   — per-index block hits and reads',
								'  "pg_statio_user_sequences" — sequence block hits and reads',
								'  "pg_stat_database_conflicts" — recovery conflicts per database',
								'  "pg_stat_archiver"         — WAL archiving activity and failures',
								'  "pg_stat_slru"             — SLRU cache (commit log, subtransaction, notify) hits and reads',
								'  "pg_stat_user_functions"   — per-function call count and total/self time',
								'  "pg_stat_wal"              — WAL bytes written, WAL sync time, full-page writes',
								'  "pg_stat_replication_slots" — replication slot activity',
								'  "pg_stat_io"               — I/O by backend type and I/O object (PG16+)',
								'  "pg_stat_activity"         — active queries, wait events, client info (snapshot of live state)',
								'  "pg_stat_replication"      — streaming replication lag and state',
								'  "pg_stat_subscription"     — subscription apply stats',
								'  "pg_stat_subscription_stats" — per-subscription error and conflict counts',
								'  "pg_stat_statements"       — SPECIAL: collected once at bench end, not on interval. Include here or set pg_stat_collect_statements=true.',
								'Tip: for focused benchmarks use a subset, e.g. ["pg_stat_database","pg_stat_user_tables","pg_stat_wal","pg_stat_io"]'
							],
							pg_stat_interval_seconds: 'How often to take snapshots during the bench, in seconds. Supports {{PARAM}}. Empty = use the design\'s snapshot_interval_seconds (default 30). Shorter intervals (e.g. 5) give finer time-series resolution but add more rows. Placeholder example: "30 or {{INTERVAL}}"',
							pg_stat_pg_locks_enabled: 'boolean — whether to also collect pg_locks on each interval. pg_locks captures active locks and waiting queries — useful for contention analysis but can be noisy under high concurrency. Defaults to false.',
							pg_stat_pg_locks_interval: 'Collection interval for pg_locks in seconds. Supports {{PARAM}}. Empty = use pg_stat_interval_seconds. Set higher (e.g. "60") to sample locks less frequently. Placeholder example: "60 or {{LOCKS_INTERVAL}}"',
							pg_stat_reset_stats: 'boolean — call pg_stat_reset() before the benchmark starts. Zeroes all cumulative counters in pg_stat_database, pg_stat_user_tables, pg_statio_*, pg_stat_wal, etc. Recommended: true — gives clean deltas for what the benchmark caused.',
							pg_stat_reset_statements: 'boolean — call pg_stat_statements_reset() before the benchmark. Clears query-level counters so pg_stat_statements only shows queries from this run. No-op if pg_stat_statements is not installed.',
							pg_stat_collect_statements: 'boolean — collect one pg_stat_statements snapshot at bench end: total calls, mean exec time, rows, plan info per query. Requires pg_stat_statements to be installed. Equivalent to adding "pg_stat_statements" to pg_stat_tables.',
							enabled: 'boolean'
						},
						note: 'Snapshots are tagged with _phase ("pre"/"bench"/"post") — use MAX(col)-MIN(col) WHERE _phase=\'bench\' to compute deltas for cumulative counters.'
					},
					perf: {
						description: 'Linux perf profiling step. Runs perf alongside the benchmark to collect CPU performance counters (perf stat), CPU flame graphs (perf record), or system-call traces (perf trace). Enable one or more sub-modes independently. Requires perf to be installed on the VPS and adequate permissions (perf_event_paranoid ≤ 1 or CAP_PERFMON).',
						fields: {
							type: '"perf"',
							name: 'string',
							position: 'integer (does not affect execution — perf always runs concurrently with the bench step)',
							perf_stat_enabled: 'boolean — enable `perf stat`: collects hardware and software performance counter summaries (cycles, instructions, cache-misses, branch-misses, task-clock, context-switches). Low overhead. Results in the run log.',
							perf_record_enabled: 'boolean — enable `perf record`: CPU sampling for flame graph generation. Higher overhead. Produces a perf.data file that is converted to a flamegraph SVG.',
							perf_trace_enabled: 'boolean — enable `perf trace`: system-call tracing. Shows which syscalls the process makes and their latency. Can be very verbose under I/O-heavy workloads.',
							perf_events: 'Comma-separated hardware/software event list for perf stat and perf record. Supports {{PARAM}}. Examples: "cycles,instructions,cache-misses,branch-misses" or "cycles:u,instructions:u" (user-space only). Empty = perf default (task-clock). Hardware events require hardware PMU support on the host. Placeholder example: "task-clock,context-switches,page-faults or {{EVENTS}}"',
							perf_duration: 'How long to run perf in seconds. Supports {{PARAM}} (e.g. "{{DURATION_SECS}}"). Empty = run for the full duration of the bench step. Use a shorter value to sample only the steady-state portion. Placeholder example: "{{DURATION}} or 30"',
							perf_stat_duration: 'Duration override for perf stat only, in seconds. Supports {{PARAM}}. Empty = use perf_duration. Placeholder example: "{{DURATION}} or 30"',
							perf_record_duration: 'Duration override for perf record only, in seconds. Supports {{PARAM}}. Empty = use perf_duration. Placeholder example: "{{DURATION}} or 30"',
							perf_trace_duration: 'Duration override for perf trace only, in seconds. Supports {{PARAM}}. Empty = use perf_duration. Placeholder example: "{{DURATION}} or 15"',
							perf_delay: 'Seconds to wait after the bench step starts before beginning perf collection. Supports {{PARAM}}. Useful to skip the warm-up phase and profile only steady-state load. Placeholder example: "0 or {{WARMUP_SECS}}"',
							perf_stat_delay: 'Delay override for perf stat only, in seconds. Supports {{PARAM}}. Empty = use perf_delay. Placeholder example: "0 or {{WARMUP_SECS}}"',
							perf_record_delay: 'Delay override for perf record only, in seconds. Supports {{PARAM}}. Empty = use perf_delay. Placeholder example: "0 or {{WARMUP_SECS}}"',
							perf_trace_delay: 'Delay override for perf trace only, in seconds. Supports {{PARAM}}. Empty = use perf_delay. Placeholder example: "0 or {{WARMUP_SECS}}"',
							perf_cgroup: 'cgroup path to scope perf collection to the PostgreSQL process group. Empty = system-wide. Cgroup scoping requires perf_scope="postgres_cgroup" on the server record. Placeholder example: "system.slice/postgresql.service or {{CGROUP}}"',
							perf_repeat: 'Number of times to repeat the perf stat collection cycle within the bench. Supports {{PARAM}}. "1" = once. "3" = three times with equal spacing to average out variance. Placeholder example: "optional or {{REPEAT}}"',
							perf_freq: 'Sampling frequency for perf record, in Hz. Supports {{PARAM}}. Default "99" (avoids lockstep with 100Hz timers). Use "999" for higher resolution. Higher = more data = more overhead. Placeholder example: "99 or {{FREQ}}"',
							perf_call_graph: 'Stack unwinding method for perf record flame graphs: "dwarf" (default — uses DWARF debug info, broad compat), "fp" (frame pointer — very low overhead, needs -fno-omit-frame-pointer), "lbr" (Intel hardware only, zero overhead).',
							perf_mmap_pages: 'Ring buffer size for perf record/trace in pages (must be power of 2). Default "4096" (16 MB). Increase if you see "lost samples" or "dropped events" under high event rates. Supports {{PARAM}}. Placeholder example: "4096 or {{MMAP_PAGES}}"',
							enabled: 'boolean'
						},
						note: 'Requires perf installed on the VPS runner. perf record output is converted to flamegraph SVG and stored with the run. Results are viewable in the run detail page.'
					}
				},
				param_syntax: 'Write {{PARAM_NAME}} in any step script or pgbench_options (also used for sysbench flags). Set the value with set_params. Example: "INSERT INTO users SELECT generate_series(1, {{NUM_USERS}})"',
				design_server_assignment: 'When creating a design, you can set server_id, database, and snapshot settings with configure_design. You can also override server_id, database, snapshot_interval_seconds, and ec2_server_id at run time with run_design.',
				recommended_workflow: [
					'1. get_context (this tool) — understand conventions and see available servers',
					'2. list_decisions — find existing decisions, or create_decision for a new one',
					'3. create_design(decision_id, name) — create a design candidate (repeat for each candidate)',
					'4. configure_design(design_id, {server_id, database}) — assign a server from the database_servers list',
					'5. get_db_schema(design_id) — see real table/column names from the live DB',
					'6a. set_decision_params(decision_id, [{name, value}]) — PREFERRED: set all params that are the same across designs here. One change propagates to every design. Use for NUM_CLIENTS, DURATION_SECS, NUM_ROWS, NUM_USERS, pgbench script weights (weight_expr), SNAPSHOT_INTERVAL, etc. Suite runs use ONLY decision-level params, so anything used in a suite MUST be here.',
					'6b. set_params(design_id, [{name, value}]) — ONLY for values that intentionally differ per design (e.g. a table variant name or index type). Avoid duplicating decision-level params here.',
					'7. upsert_step (repeat) — add sql setup steps, one pg_stat config step (opt-in snapshot collection), pgbench or sysbench load step, and sql teardown steps. Optionally add a proc step for OS host metrics.',
					'8a. upsert_decision_profile(decision_id, name, values) — optional: create decision-level profiles (e.g. "small"/"large") for suite runs. Use list_decision_profiles / delete_decision_profile to manage them.',
					'8b. upsert_profile(design_id, name, values) — optional: create design-level profiles for single/series runs.',
					'9. validate_design(design_id) — check for issues (undefined params, missing server, no bench step) before running',
					'10. run_design(design_id, {profile_id?, profile_source?, name?, server_id?, database?, snapshot_interval_seconds?, ec2_server_id?}) — start a test run and get run_id. Pass profile_source="decision" to use a decision-level profile.',
					'11. get_run(run_id) — wait ~(bench duration + collect durations) before first poll, then every ~30s',
					'12. export_plan(design_id) — get plan.json for production mybench-runner CLI',
					'--- Analysis (after runs complete) ---',
					'13. get_collected_data_schema() — learn the schema of all snap_* and host_snap_* tables so you know what to query',
					'14. query_run_data(sql, params) — write SELECT queries against snap_* tables to compute deltas, compare runs, and find root causes'
				],
				recommended_step_structure: {
					description: 'Always follow this 9-step order when building a benchmark design. Each step has a specific purpose — do not skip or merge steps.',
					steps: [
						{
							position: 0, type: 'sql',
							name: '1 — Init schema (no indexes/constraints)',
							purpose: 'Create tables in their bare form: no indexes, no CHECK, no FOREIGN KEY, no UNIQUE (except PK). Maximises INSERT throughput during seeding.',
							tip: 'Use UNLOGGED tables if crash-safety is not needed during setup — convert to LOGGED in step 3.',
							example: 'DROP TABLE IF EXISTS orders CASCADE;\nCREATE UNLOGGED TABLE orders (\n  id BIGSERIAL PRIMARY KEY,\n  user_id BIGINT,\n  total NUMERIC\n);'
						},
						{
							position: 1, type: 'sql',
							name: '2 — Seed data',
							purpose: 'Bulk-insert the realistic dataset using generate_series or COPY. Insert without constraint overhead from step 1.',
							tip: 'Use {{NUM_ROWS}}, {{NUM_USERS}} params so profiles can scale the dataset. Emit RAISE NOTICE every 100k rows for progress.',
							example: 'INSERT INTO orders (user_id, total)\n  SELECT (random()*{{NUM_USERS}})::bigint,\n         (random()*10000)::numeric\n  FROM generate_series(1, {{NUM_ROWS}});'
						},
						{
							position: 2, type: 'sql',
							name: '3 — Add indexes, constraints, foreign keys',
							purpose: 'Add all indexes, CHECK, FOREIGN KEY, and UNIQUE constraints now. Building them after bulk-insert is far faster than maintaining them row-by-row.',
							tip: 'If the table was UNLOGGED, convert it here: ALTER TABLE orders SET LOGGED;',
							example: 'ALTER TABLE orders SET LOGGED;\nALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);\nCREATE INDEX ON orders (user_id);\nCREATE INDEX ON orders (created_at DESC);'
						},
						{
							position: 3, type: 'sql', no_transaction: true,
							name: '4 — Maintenance (VACUUM, ANALYZE, CHECKPOINT, warm buffers)',
							purpose: 'Bring the database to a clean, production-like state. Eliminates noise from dead tuples, stale stats, or cold buffers.',
							tip: 'Must use no_transaction: true — VACUUM and CHECKPOINT cannot run inside a transaction. Warm the buffer pool with a full seqscan on hot tables.',
							example: 'VACUUM ANALYZE orders;\nVACUUM ANALYZE users;\nCHECKPOINT;\n-- Warm buffer pool\nSELECT COUNT(*) FROM orders;\nSELECT COUNT(*) FROM users;'
						},
						{
							position: 4, type: 'sql',
							name: '5 — Table sizes before benchmark',
							purpose: 'Snapshot table and index sizes before load so you can measure write amplification and bloat caused by the benchmark.',
							example: "SELECT relname,\n       pg_size_pretty(pg_total_relation_size(oid)) AS total,\n       pg_size_pretty(pg_relation_size(oid)) AS heap,\n       pg_size_pretty(pg_indexes_size(oid)) AS indexes\nFROM pg_class\nWHERE relname IN ('orders','users')\nORDER BY relname;"
						},
						{
							position: 5, type: 'pg_stat',
							name: '6 — pg_stat collection config',
							purpose: 'CONFIGURATION ONLY — declares which PostgreSQL stats to collect and at what interval. This step does not execute in sequence. The runner automatically takes snapshots before/during/after the bench step no matter where this step appears in the list. Placing it after pgbench has no effect — do not do that.',
							tip: 'Set pg_stat_reset_stats: true to zero cumulative counters before the benchmark so deltas are clean. Set pg_stat_collect_statements: true (or add "pg_stat_statements" to pg_stat_tables) to capture per-query stats at bench end — this is separate from the pg_stat step itself.',
							example_fields: {
								pg_stat_tables: '[]',
								pg_stat_interval_seconds: '{{SNAPSHOT_INTERVAL}}',
								pg_stat_reset_stats: true,
								pg_stat_reset_statements: true,
								pg_stat_collect_statements: true
							}
						},
						{
							position: 6, type: 'pgbench',
							name: '7 — Benchmark',
							purpose: 'The actual load test. Script weights must sum to ≤ 100. Use --no-vacuum to prevent pgbench from running its own VACUUM during the test.',
							tip: 'Model a realistic read/write mix with multiple scripts and weights. {{NUM_CLIENTS}}, {{NUM_THREADS}}, {{DURATION_SECS}} are the key params.',
							example_options: '-c {{NUM_CLIENTS}} -j {{NUM_THREADS}} -T {{DURATION_SECS}} --no-vacuum',
							example_scripts: [
								{ name: 'write', weight: 30, script: '\\set uid random(1, {{NUM_USERS}})\nBEGIN;\nINSERT INTO orders (user_id, total) VALUES (:uid, random()*1000);\nEND;' },
								{ name: 'read', weight: 70, script: '\\set uid random(1, {{NUM_USERS}})\nSELECT * FROM orders WHERE user_id = :uid LIMIT 10;' }
							]
						},
						{
							position: 7, type: 'sql',
							name: '8 — Table sizes after benchmark',
							purpose: 'Re-run the same size query from step 5. Compare before/after to measure index bloat, heap growth, and TOAST expansion caused by writes.',
							example: "SELECT relname,\n       pg_size_pretty(pg_total_relation_size(oid)) AS total,\n       pg_size_pretty(pg_relation_size(oid)) AS heap,\n       pg_size_pretty(pg_indexes_size(oid)) AS indexes\nFROM pg_class\nWHERE relname IN ('orders','users')\nORDER BY relname;"
						},
						{
							position: 8, type: 'sql',
							name: '9 — Teardown',
							purpose: 'Drop all tables created in step 1. Use CASCADE to handle foreign keys. Leave the database clean for the next run.',
							example: 'DROP TABLE IF EXISTS orders CASCADE;\nDROP TABLE IF EXISTS users CASCADE;'
						}
					]
				},
				example_steps: {
					sql_setup: {
						type: 'sql', name: 'Setup', position: 0, enabled: true,
						script: 'DROP TABLE IF EXISTS payments;\nCREATE TABLE payments (id BIGSERIAL PRIMARY KEY, user_id INT, amount INT);\nINSERT INTO payments (user_id, amount)\n  SELECT (random()*{{NUM_USERS}})::int, (random()*1000)::int\n  FROM generate_series(1, {{NUM_ROWS}});'
					},
					pg_stat: {
						type: 'pg_stat', name: 'pg_stat collection', position: 1, enabled: true,
						pg_stat_tables: '[]',
						pg_stat_interval_seconds: '30',
						pg_stat_reset_stats: true,
						pg_stat_reset_statements: true,
						pg_stat_collect_statements: true
					},
					pgbench: {
						type: 'pgbench', name: 'Benchmark', position: 2, enabled: true,
						pgbench_options: '-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum',
						pgbench_scripts: [{ name: 'main', weight: 1, script: '\\set uid random(1, {{NUM_USERS}})\nBEGIN;\nUPDATE payments SET amount = amount - 10 WHERE user_id = :uid;\nEND;' }]
					},
					sql_teardown: { type: 'sql', name: 'Teardown', position: 3, script: 'DROP TABLE IF EXISTS payments;', enabled: true }
				}
			};
			return text(guide);
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// PostgreSQL / Settings tools
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'list_pg_servers',
		{
			description: 'Lists saved PostgreSQL connections from Settings. Returns non-secret fields only.'
		},
		async () => {
			return text(listPgServers().map(scrubPgServer));
		}
	);

	server.registerTool(
		'save_pg_server',
		{
			description: 'Creates or updates a saved PostgreSQL connection in Settings. If server_id is omitted, creates a new connection. When updating, omitted fields keep their current values.',
			inputSchema: {
				server_id: z.number().int().optional().describe('Omit to create a new PostgreSQL connection'),
				name: z.string().optional(),
				host: z.string().optional(),
				port: z.number().int().optional(),
				username: z.string().optional(),
				password: z.string().optional().describe('Optional password; omitted on update keeps the current password'),
				ssl: z.boolean().optional()
			}
		},
		async ({ server_id, name, host, port, username, password, ssl }) => {
			try {
				const result = savePgServer({ server_id, name, host, port, username, password, ssl });
				return text({ action: result.action, server: scrubPgServer(result.server) });
			} catch (err) {
				return text({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	);

	server.registerTool(
		'delete_pg_server',
		{
			description: 'Deletes a saved PostgreSQL connection from Settings.',
			inputSchema: {
				server_id: z.number().int()
			}
		},
		async ({ server_id }) => {
			try {
				return text(deletePgServer(server_id));
			} catch (err) {
				return text({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	);

	server.registerTool(
		'test_pg_server',
		{
			description: 'Tests a PostgreSQL connection. If server_id is provided, tests the saved connection; otherwise tests the provided fields without saving.',
			inputSchema: {
				server_id: z.number().int().optional().describe('Optional saved PostgreSQL connection ID'),
				host: z.string().optional().describe('Required when server_id is omitted'),
				port: z.number().int().optional(),
				username: z.string().optional(),
				password: z.string().optional(),
				ssl: z.boolean().optional(),
				database: z.string().optional().describe('Database name to test against; defaults to "postgres"')
			}
		},
		async ({ server_id, host, port, username, password, ssl, database }) => {
			try {
				return text(await testPgServer({ server_id, host, port, username, password, ssl, database }));
			} catch (err) {
				return text({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// EC2 / Settings tools
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'list_ec2_servers',
		{
			description: 'Lists saved EC2 runner connections from Settings. Returns non-secret fields only.'
		},
		async () => {
			return text(listEc2Servers().map(scrubEc2Server));
		}
	);

	server.registerTool(
		'save_ec2_server',
		{
			description: 'Creates or updates a saved EC2 runner in Settings. If ec2_server_id is omitted, creates a new server. When updating, omitted fields keep their current values.',
			inputSchema: {
				ec2_server_id: z.number().int().optional().describe('Omit to create a new EC2 runner'),
				name: z.string().optional(),
				host: z.string().optional(),
				user: z.string().optional(),
				port: z.number().int().optional(),
				private_key: z.string().optional().describe('Optional PEM private key; omitted on update keeps the current key'),
				remote_dir: z.string().optional(),
				log_dir: z.string().optional()
			}
		},
		async ({ ec2_server_id, name, host, user, port, private_key, remote_dir, log_dir }) => {
			try {
				const result = saveEc2Server({ ec2_server_id, name, host, user, port, private_key, remote_dir, log_dir });
				return text({ action: result.action, server: scrubEc2Server(result.server) });
			} catch (err) {
				return text({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	);

	server.registerTool(
		'delete_ec2_server',
		{
			description: 'Deletes a saved EC2 runner from Settings.',
			inputSchema: {
				ec2_server_id: z.number().int()
			}
		},
		async ({ ec2_server_id }) => {
			try {
				return text(deleteEc2Server(ec2_server_id));
			} catch (err) {
				return text({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	);

	server.registerTool(
		'test_ec2_server',
		{
			description: 'Tests an EC2 runner connection. If ec2_server_id is provided, tests the saved server; otherwise tests the provided fields without saving. The result includes checks: ssh (connection), binary (mybench-runner present), pgbench, and sysbench.',
			inputSchema: {
				ec2_server_id: z.number().int().optional().describe('Optional saved EC2 runner ID'),
				host: z.string().optional().describe('Required when ec2_server_id is omitted'),
				user: z.string().optional(),
				port: z.number().int().optional(),
				private_key: z.string().optional().describe('Required when ec2_server_id is omitted'),
				remote_dir: z.string().optional(),
				log_dir: z.string().optional()
			}
		},
		async ({ ec2_server_id, host, user, port, private_key, remote_dir, log_dir }) => {
			try {
				return text(await testEc2Server({ ec2_server_id, host, user, port, private_key, remote_dir, log_dir }));
			} catch (err) {
				return text({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// create_decision
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'create_decision',
		{
			description: 'Creates a new decision (the benchmarking question, e.g. "plain table vs partitioned table"). After creating, use create_design to add design candidates.',
			inputSchema: {
				name: z.string().describe('Short name for the decision, e.g. "payment table design"'),
				description: z.string().optional().describe('Longer description of what you are trying to decide')
			}
		},
		async ({ name, description }) => {
			const db = getDb();
			const result = db.prepare('INSERT INTO decisions (name, description) VALUES (?, ?)').run(name, description ?? '');
			return text({ decision_id: result.lastInsertRowid });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// list_decisions
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'list_decisions',
		{
			description: 'Lists all decisions and their designs. A decision is the benchmarking question; each design is one candidate answer to benchmark. Use this to find existing work before creating new decisions.'
		},
		async () => {
			const db = getDb();
			const decisions = db.prepare('SELECT * FROM decisions ORDER BY id').all() as { id: number; name: string; description: string }[];
			const designs = db.prepare('SELECT id, decision_id, name, description FROM designs ORDER BY id').all() as { id: number; decision_id: number; name: string; description: string }[];
			const byDecision = new Map<number, typeof designs>();
			for (const d of designs) {
				const arr = byDecision.get(d.decision_id) ?? [];
				arr.push(d);
				byDecision.set(d.decision_id, arr);
			}
			return text(decisions.map(dec => ({ ...dec, designs: byDecision.get(dec.id) ?? [] })));
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'get_design',
		{
			description: 'Returns a design with all its steps, pgbench scripts, params, and inherited decision-level params. The `params` field contains design-local params; `decision_params` contains params inherited from the decision (read-only on the design, always used in suite runs). Use this to inspect an existing design before modifying it.',
			inputSchema: {
				design_id: z.number().int().describe('Design ID from list_decisions')
			}
		},
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id) as ({ decision_id: number } & Record<string, unknown>) | undefined;
			if (!design) return text({ error: `Design ${design_id} not found` });
			const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(design_id) as DesignStep[];
			const scripts = db.prepare('SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position').all(design_id) as PgbenchScript[];
			const params = db.prepare('SELECT * FROM design_params WHERE design_id = ? ORDER BY position').all(design_id) as DesignParam[];
			// Decision-level inherited params (read-only on design, used in suite runs exclusively)
			const decisionParams = design.decision_id
				? db.prepare('SELECT * FROM decision_params WHERE decision_id = ? ORDER BY position').all(design.decision_id)
				: [];
			const scriptsByStep = new Map<number, PgbenchScript[]>();
			for (const ps of scripts) {
				const arr = scriptsByStep.get(ps.step_id) ?? [];
				arr.push(ps);
				scriptsByStep.set(ps.step_id, arr);
			}
			return text({ ...design, steps: steps.map(s => ({ ...s, pgbench_scripts: scriptsByStep.get(s.id) ?? [] })), params, decision_params: decisionParams });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// create_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'create_design',
		{
			description: 'Creates a new design under a decision. A design is one candidate to benchmark. After creating, use configure_design to set the server and database, then upsert_step and set_params.',
			inputSchema: {
				decision_id: z.number().int().describe('Decision ID from list_decisions'),
				name: z.string().describe('Short name, e.g. "plain table" or "partitioned"'),
				description: z.string().optional().describe('Optional longer description')
			}
		},
		async ({ decision_id, name, description }) => {
			const db = getDb();
			const result = db.prepare('INSERT INTO designs (decision_id, name, description) VALUES (?, ?, ?)').run(decision_id, name, description ?? '');
			return text({ design_id: result.lastInsertRowid });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// configure_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'configure_design',
		{
			description: `Updates the configuration of an existing design: server, database, description, and snapshot settings.
Use get_context to see available server IDs. All fields are optional — only provided fields are updated.
Call this after create_design to assign a server before running the design.`,
			inputSchema: {
				design_id: z.number().int(),
				server_id: z.number().int().optional().describe('PG server ID from get_context database_servers list'),
				database: z.string().optional().describe('Database name on the server to benchmark against'),
				description: z.string().optional().describe('Human-readable description of this design'),
				snapshot_interval_seconds: z.number().int().optional().describe('How often to take pg_stat_* snapshots during benchmarks (default 30)'),
				pre_collect_secs: z.number().int().optional().describe('Seconds of pg_stat collection before pgbench (legacy, prefer collect steps)'),
				post_collect_secs: z.number().int().optional().describe('Seconds of pg_stat collection after pgbench (legacy, prefer collect steps)')
			}
		},
		async ({ design_id, server_id, database, description, snapshot_interval_seconds, pre_collect_secs, post_collect_secs }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id);
			if (!design) return text({ error: `Design ${design_id} not found` });

			const fields: string[] = [];
			const values: unknown[] = [];
			if (server_id !== undefined)              { fields.push('server_id = ?');              values.push(server_id); }
			if (database !== undefined)               { fields.push('database = ?');               values.push(database); }
			if (description !== undefined)            { fields.push('description = ?');            values.push(description); }
			if (snapshot_interval_seconds !== undefined) { fields.push('snapshot_interval_seconds = ?'); values.push(snapshot_interval_seconds); }
			if (pre_collect_secs !== undefined)       { fields.push('pre_collect_secs = ?');       values.push(pre_collect_secs); }
			if (post_collect_secs !== undefined)      { fields.push('post_collect_secs = ?');      values.push(post_collect_secs); }

			if (fields.length === 0) return text({ message: 'Nothing to update — no fields provided.' });

			values.push(design_id);
			db.prepare(`UPDATE designs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

			return text({ updated: true, design_id, fields: fields.map(f => f.split(' ')[0]) });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// upsert_step
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'upsert_step',
		{
			description: `Adds a new step or updates an existing step in a design. If step_id is provided, updates that step; otherwise inserts a new one.
Step types:
  "sql"      — provide script (SQL text, supports {{PARAM}})
  "pgbench"  — provide pgbench_options and pgbench_scripts [{name, weight, script}]
  "sysbench" — provide pgbench_options as "testname command [flags]" (e.g. "oltp_read_write run --tables=10 --threads=4 --time=60") or script (custom Lua content).
  "pg_stat"  — CONFIGURATION-ONLY step. Does NOT run in sequence. The runner automatically snapshots PostgreSQL stats before/during/after the bench regardless of this step's position — do NOT place it after pgbench to "collect after". One per design. Key fields: pg_stat_tables (JSON array of PG view names; empty = all), pg_stat_interval_seconds, pg_stat_reset_stats, pg_stat_reset_statements, pg_stat_collect_statements (set true to capture pg_stat_statements query data at bench end). Not the same as the pg_stat_statements extension — to collect query-level data use pg_stat_collect_statements=true.
  "perf"     — Linux perf profiling alongside the bench. Enable sub-modes independently: perf_stat_enabled (counter summary), perf_record_enabled (flame graph), perf_trace_enabled (syscall trace). Duration/delay fields all support {{PARAM}}. See step_types.perf in get_context for full field docs.
  "proc"     — Linux /proc host metrics via SSH to the database server. Configuration-only; collection starts at bench time. proc_groups selects which /proc files to read; proc_interval_seconds supports {{PARAM}}. Requires SSH on the PG server record. See step_types.proc in get_context for group key descriptions.
Use {{PARAM_NAME}} in scripts and pgbench_options — values come from set_params.`,
			inputSchema: {
				design_id: z.number().int(),
				step_id: z.number().int().optional().describe('Omit to insert a new step'),
				type: z.enum(['sql', 'pgbench', 'sysbench', 'pg_stat', 'perf', 'proc']),
				name: z.string(),
				position: z.number().int().describe('Execution order, 0-based. Lower = runs earlier.'),
				enabled: z.boolean().default(true),
				script: z.string().optional().describe('SQL text for type=sql; Lua script content for type=sysbench'),
				no_transaction: z.boolean().optional().describe('If true, SQL runs without wrapping in a transaction'),
				pgbench_options: z.string().optional().describe('pgbench CLI flags for type=pgbench (e.g. "-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum"); for type=sysbench: "testname command [flags]" (e.g. "oltp_read_write run --tables=10 --threads=4 --time=60")'),
				pgbench_scripts: z.array(z.object({
					name: z.string(),
					weight: z.number().int().default(1).describe('Fixed integer transaction mix weight. pgbench selects this script proportionally — weight 30 out of total 100 means ~30% of transactions. All weights must sum to ≤ 100. Ignored when weight_expr is set.'),
					weight_expr: z.string().optional().describe('Parameterized weight expression — use {{PARAM_NAME}} here to drive the weight from a decision-level or design-level param (e.g. "{{TRANSFER_WEIGHT}}"). Overrides the weight field when set. This is the recommended approach when you want to control the transaction mix ratio from a single decision param shared across multiple designs. The expression is substituted at run time and must resolve to a non-negative integer.'),
					script: z.string().describe('pgbench custom script: use \\set, BEGIN, SQL, END. Supports {{PARAM}}.')
				})).optional().describe('Custom scripts for type=pgbench only'),
				duration_secs: z.number().int().optional().describe('Snapshot collection duration for type=collect'),
				perf_stat_enabled: z.boolean().optional().describe('[type=perf] Enable perf stat: hardware/software counter summaries (cycles, instructions, cache-misses, branch-misses). Low overhead.'),
				perf_record_enabled: z.boolean().optional().describe('[type=perf] Enable perf record: CPU sampling for flame graph generation. Produces a perf.data file converted to SVG. Higher overhead than perf stat.'),
				perf_trace_enabled: z.boolean().optional().describe('[type=perf] Enable perf trace: system-call tracing — shows which syscalls fire and their latency. Can be very verbose on I/O-heavy workloads.'),
				perf_events: z.string().optional().describe('[type=perf] Comma-separated perf event list for perf stat/record. Supports {{PARAM}}. Empty = default (task-clock). E.g. "task-clock,context-switches,page-faults or {{EVENTS}}" or hardware events "cycles,instructions,cache-misses,branch-misses".'),
				perf_duration: z.string().optional().describe('[type=perf] How long to run perf in seconds. Supports {{PARAM}}. Empty = full bench duration. E.g. "{{DURATION}} or 30". Use shorter value to profile steady-state only.'),
				perf_stat_duration: z.string().optional().describe('[type=perf] Duration override for perf stat only, in seconds. Supports {{PARAM}}. Empty = use perf_duration. E.g. "{{DURATION}} or 30".'),
				perf_record_duration: z.string().optional().describe('[type=perf] Duration override for perf record only, in seconds. Supports {{PARAM}}. Empty = use perf_duration. E.g. "{{DURATION}} or 30".'),
				perf_trace_duration: z.string().optional().describe('[type=perf] Duration override for perf trace only, in seconds. Supports {{PARAM}}. Empty = use perf_duration. E.g. "{{DURATION}} or 15".'),
				perf_delay: z.string().optional().describe('[type=perf] Seconds to wait after bench starts before perf begins. Supports {{PARAM}}. Skip warm-up; profile steady-state only. E.g. "0 or {{WARMUP_SECS}}".'),
				perf_stat_delay: z.string().optional().describe('[type=perf] Delay for perf stat only, in seconds. Supports {{PARAM}}. Empty = use perf_delay. E.g. "0 or {{WARMUP_SECS}}".'),
				perf_record_delay: z.string().optional().describe('[type=perf] Delay for perf record only, in seconds. Supports {{PARAM}}. Empty = use perf_delay. E.g. "0 or {{WARMUP_SECS}}".'),
				perf_trace_delay: z.string().optional().describe('[type=perf] Delay for perf trace only, in seconds. Supports {{PARAM}}. Empty = use perf_delay. E.g. "0 or {{WARMUP_SECS}}".'),
				perf_cgroup: z.string().optional().describe('[type=perf] cgroup path to scope collection to the PostgreSQL process group. Empty = system-wide. E.g. "system.slice/postgresql.service or {{CGROUP}}".'),
				perf_repeat: z.string().optional().describe('[type=perf] Times to repeat the perf stat collection cycle. Supports {{PARAM}}. Averages out variance. E.g. "optional or {{REPEAT}}".'),
				perf_freq: z.string().optional().describe('[type=perf] Sampling frequency for perf record in Hz. Supports {{PARAM}}. Default "99" (avoids lockstep with 100Hz timers). E.g. "99 or {{FREQ}}".'),
				perf_call_graph: z.string().optional().describe('[type=perf] Stack unwinding for flame graphs: "dwarf" (default, broad compat), "fp" (low overhead, needs -fno-omit-frame-pointer), "lbr" (Intel only, zero overhead).'),
				perf_mmap_pages: z.string().optional().describe('[type=perf] Ring buffer size for perf record/trace in pages (must be power of 2). Supports {{PARAM}}. Default "4096" (16 MB). Increase if you see lost samples or dropped events. E.g. "4096 or {{MMAP_PAGES}}"'),
				proc_groups: z.string().optional().describe('[type=proc] JSON array of /proc group keys to collect. Empty array or omit = all groups. System groups: "loadavg" (/proc/loadavg), "meminfo" (/proc/meminfo), "stat" (/proc/stat — per-CPU ticks), "vmstat" (/proc/vmstat), "diskstats" (/proc/diskstats), "net_dev" (/proc/net/dev), "schedstat" (/proc/schedstat), "pressure" (/proc/pressure/), "file_nr" (/proc/sys/fs/file-nr). Per-process groups (postgres PID): "pid_stat","pid_statm","pid_io","pid_schedstat","pid_wchan","pid_fd","pid_status". Recommended minimal set: \'["loadavg","meminfo","stat","diskstats","pid_stat","pid_io"]\''),
				proc_interval_seconds: z.string().optional().describe('[type=proc] Collection interval in seconds. Supports {{PARAM}}. Empty = use design snapshot_interval_seconds. Use "1" for high-resolution sampling; "5"–"10" for lighter overhead. E.g. "30 or {{INTERVAL}} — leave empty to use run default".'),
				pg_stat_tables: z.string().optional().describe('[type=pg_stat] JSON array of PG view names to snapshot on each interval. Empty array = all supported tables (recommended). Available: "pg_stat_database","pg_stat_bgwriter","pg_stat_checkpointer","pg_stat_user_tables","pg_stat_user_indexes","pg_statio_user_tables","pg_statio_user_indexes","pg_statio_user_sequences","pg_stat_database_conflicts","pg_stat_archiver","pg_stat_slru","pg_stat_user_functions","pg_stat_wal","pg_stat_replication_slots","pg_stat_io","pg_stat_activity","pg_stat_replication","pg_stat_subscription","pg_stat_subscription_stats". Add "pg_stat_statements" to collect it once at bench end. Focused example: \'["pg_stat_database","pg_stat_user_tables","pg_stat_wal","pg_stat_io"]\''),
				pg_stat_interval_seconds: z.string().optional().describe('[type=pg_stat] Snapshot interval in seconds. Supports {{PARAM}}. Empty = use design snapshot_interval_seconds (default 30). Lower values give finer resolution. E.g. "30 or {{INTERVAL}}".'),
				pg_stat_pg_locks_enabled: z.boolean().optional().describe('[type=pg_stat] Enable pg_locks collection on each interval. Captures active locks and waiting queries — useful for contention analysis but noisy under high concurrency. Defaults to false.'),
				pg_stat_pg_locks_interval: z.string().optional().describe('[type=pg_stat] Collection interval for pg_locks in seconds. Supports {{PARAM}}. Empty = use pg_stat_interval_seconds. Set higher (e.g. "60") to reduce row volume. E.g. "60 or {{LOCKS_INTERVAL}}".'),
				pg_stat_reset_stats: z.boolean().optional().describe('[type=pg_stat] Call pg_stat_reset() before bench — zeroes cumulative counters in pg_stat_database, pg_stat_user_tables, pg_statio_*, pg_stat_wal, etc. Recommended: true for clean deltas.'),
				pg_stat_reset_statements: z.boolean().optional().describe('[type=pg_stat] Call pg_stat_statements_reset() before bench — clears query counters so only this run\'s queries appear. No-op if pg_stat_statements is not installed.'),
				pg_stat_collect_statements: z.boolean().optional().describe('[type=pg_stat] Collect one pg_stat_statements snapshot at bench end: total calls, mean exec time, rows, plan info per query. Requires pg_stat_statements. Equivalent to adding "pg_stat_statements" to pg_stat_tables.')
			}
		},
		async ({ design_id, step_id, type, name, position, enabled, script, no_transaction, pgbench_options, pgbench_scripts, duration_secs,
			perf_stat_enabled, perf_record_enabled, perf_trace_enabled, perf_events, perf_duration,
			perf_stat_duration, perf_record_duration, perf_trace_duration,
			perf_delay, perf_stat_delay, perf_record_delay, perf_trace_delay,
			perf_cgroup, perf_repeat, perf_freq, perf_call_graph, perf_mmap_pages,
			proc_groups, proc_interval_seconds,
			pg_stat_tables, pg_stat_interval_seconds, pg_stat_pg_locks_enabled, pg_stat_pg_locks_interval,
			pg_stat_reset_stats, pg_stat_reset_statements, pg_stat_collect_statements }) => {
			const db = getDb();
			let resolvedStepId: number;
			if (step_id) {
				db.prepare(`UPDATE design_steps SET type=?, name=?, position=?, enabled=?, script=?, no_transaction=?, pgbench_options=?, duration_secs=?,
					perf_stat_enabled=?, perf_record_enabled=?, perf_trace_enabled=?, perf_events=?,
					perf_duration=?, perf_stat_duration=?, perf_record_duration=?, perf_trace_duration=?,
					perf_delay=?, perf_stat_delay=?, perf_record_delay=?, perf_trace_delay=?,
					perf_cgroup=?, perf_repeat=?, perf_freq=?, perf_call_graph=?, perf_mmap_pages=?,
					proc_groups=?, proc_interval_seconds=?,
					pg_stat_tables=?, pg_stat_interval_seconds=?, pg_stat_pg_locks_enabled=?, pg_stat_pg_locks_interval=?,
					pg_stat_reset_stats=?, pg_stat_reset_statements=?, pg_stat_collect_statements=? WHERE id=?`)
					.run(type, name, position, enabled ? 1 : 0, script ?? '', no_transaction ? 1 : 0, pgbench_options ?? '', duration_secs ?? 0,
						perf_stat_enabled ? 1 : 0, perf_record_enabled ? 1 : 0, perf_trace_enabled ? 1 : 0, perf_events ?? '',
						perf_duration ?? '', perf_stat_duration ?? '', perf_record_duration ?? '', perf_trace_duration ?? '',
						perf_delay ?? '', perf_stat_delay ?? '', perf_record_delay ?? '', perf_trace_delay ?? '',
						perf_cgroup ?? '', perf_repeat ?? '', perf_freq ?? '', perf_call_graph ?? 'dwarf', perf_mmap_pages ?? '',
						proc_groups ?? '[]', proc_interval_seconds ?? '',
						pg_stat_tables ?? '[]', pg_stat_interval_seconds ?? '',
						pg_stat_pg_locks_enabled ? 1 : 0, pg_stat_pg_locks_interval ?? '',
						pg_stat_reset_stats ? 1 : 0, pg_stat_reset_statements ? 1 : 0, pg_stat_collect_statements ? 1 : 0,
						step_id);
				resolvedStepId = step_id;
			} else {
				const r = db.prepare(`INSERT INTO design_steps (design_id, type, name, position, enabled, script, no_transaction, pgbench_options, duration_secs,
					perf_stat_enabled, perf_record_enabled, perf_trace_enabled, perf_events,
					perf_duration, perf_stat_duration, perf_record_duration, perf_trace_duration,
					perf_delay, perf_stat_delay, perf_record_delay, perf_trace_delay,
					perf_cgroup, perf_repeat, perf_freq, perf_call_graph, perf_mmap_pages,
					proc_groups, proc_interval_seconds,
					pg_stat_tables, pg_stat_interval_seconds, pg_stat_pg_locks_enabled, pg_stat_pg_locks_interval,
					pg_stat_reset_stats, pg_stat_reset_statements, pg_stat_collect_statements)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(design_id, type, name, position, enabled ? 1 : 0, script ?? '', no_transaction ? 1 : 0, pgbench_options ?? '', duration_secs ?? 0,
						perf_stat_enabled ? 1 : 0, perf_record_enabled ? 1 : 0, perf_trace_enabled ? 1 : 0, perf_events ?? '',
						perf_duration ?? '', perf_stat_duration ?? '', perf_record_duration ?? '', perf_trace_duration ?? '',
						perf_delay ?? '', perf_stat_delay ?? '', perf_record_delay ?? '', perf_trace_delay ?? '',
						perf_cgroup ?? '', perf_repeat ?? '', perf_freq ?? '', perf_call_graph ?? 'dwarf', perf_mmap_pages ?? '',
						proc_groups ?? '[]', proc_interval_seconds ?? '',
						pg_stat_tables ?? '[]', pg_stat_interval_seconds ?? '',
						pg_stat_pg_locks_enabled ? 1 : 0, pg_stat_pg_locks_interval ?? '',
						pg_stat_reset_stats ? 1 : 0, pg_stat_reset_statements ? 1 : 0, pg_stat_collect_statements ? 1 : 0);
				resolvedStepId = r.lastInsertRowid as number;
			}
			if (type === 'pgbench' && pgbench_scripts) {
				db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?').run(resolvedStepId);
				const ins = db.prepare('INSERT INTO pgbench_scripts (step_id, position, name, weight, weight_expr, script) VALUES (?, ?, ?, ?, ?, ?)');
				pgbench_scripts.forEach((ps, i) => ins.run(resolvedStepId, i, ps.name, ps.weight, ps.weight_expr ?? null, ps.script));
			}
			return text({ step_id: resolvedStepId, action: step_id ? 'updated' : 'created' });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// delete_step
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'delete_step',
		{
			description: 'Deletes a step and its associated pgbench scripts. Use get_design to find the step_id first.',
			inputSchema: { step_id: z.number().int() }
		},
		async ({ step_id }) => {
			const db = getDb();
			db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?').run(step_id);
			db.prepare('DELETE FROM design_steps WHERE id = ?').run(step_id);
			return text({ deleted: true, step_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// set_params
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'set_params',
		{
			description: `Replaces all parameters for a SINGLE design. Parameters are substituted as {{NAME}} in step scripts and pgbench_options.
Pass the complete list — this replaces existing params, not merges.
IMPORTANT: only use this for values that intentionally differ between designs (e.g. a table name or index strategy specific to this candidate). For any value that is the same across multiple designs — or that you might want to change globally — use set_decision_params instead. Decision-level params propagate to all designs automatically; design-level params require visiting each design individually when you want to change them.`,
			inputSchema: {
				design_id: z.number().int(),
				params: z.array(z.object({
					name: z.string().describe('Used as {{NAME}} in scripts'),
					value: z.string().describe('Default value (can be overridden with --param on mybench-runner CLI)')
				}))
			}
		},
		async ({ design_id, params }) => {
			const db = getDb();
			db.transaction(() => {
				db.prepare('DELETE FROM design_params WHERE design_id = ?').run(design_id);
				const ins = db.prepare('INSERT INTO design_params (design_id, position, name, value) VALUES (?, ?, ?, ?)');
				params.forEach((p, i) => ins.run(design_id, i, p.name, p.value));
			})();
			return text({ set: params.length, design_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// set_decision_params
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'set_decision_params',
		{
			description: `Replaces all decision-level parameters. These are the PRIMARY place to store params — inherited by every design under this decision automatically.
The key mental model: put a param here whenever you want one place to change and have it affect all designs. Examples: NUM_CLIENTS, DURATION_SECS, NUM_ROWS, NUM_USERS, SNAPSHOT_INTERVAL, TRANSFER_WEIGHT (pgbench script weight via weight_expr). If requirements change and you need to adjust a value, updating it here propagates to every design at once — no need to visit each design individually.
Pass the complete list — this replaces existing params, not merges.
Use set_params (design-level) only for values that intentionally differ between designs. Suite runs use ONLY decision-level params.`,
			inputSchema: {
				decision_id: z.number().int(),
				params: z.array(z.object({
					name: z.string().describe('Used as {{NAME}} in all designs that inherit this decision'),
					value: z.string().describe('Default value; can be overridden per design or per profile')
				}))
			}
		},
		async ({ decision_id, params }) => {
			const db = getDb();
			const decision = db.prepare('SELECT id FROM decisions WHERE id = ?').get(decision_id);
			if (!decision) return text({ error: `Decision ${decision_id} not found` });
			db.transaction(() => {
				db.prepare('DELETE FROM decision_params WHERE decision_id = ?').run(decision_id);
				const ins = db.prepare('INSERT INTO decision_params (decision_id, position, name, value) VALUES (?, ?, ?, ?)');
				params.forEach((p, i) => ins.run(decision_id, i, p.name, p.value));
			})();
			return text({ set: params.length, decision_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// upsert_decision_profile
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'upsert_decision_profile',
		{
			description: 'Creates or updates a named parameter profile at the decision level. Decision profiles are used exclusively in suite runs (each profile produces one series per design). Omit profile_id to create; provide it to update.',
			inputSchema: {
				decision_id: z.number().int(),
				profile_id: z.number().int().optional().describe('Omit to create a new profile'),
				name: z.string().describe('Profile name, e.g. "small", "medium", "large"'),
				values: z.array(z.object({
					param_name: z.string().describe('Param name (must match a decision param)'),
					value: z.string().describe('Override value for this profile')
				})).describe('Only include params you want to override from their defaults')
			}
		},
		async ({ decision_id, profile_id, name, values }) => {
			const db = getDb();
			const decision = db.prepare('SELECT id FROM decisions WHERE id = ?').get(decision_id);
			if (!decision) return text({ error: `Decision ${decision_id} not found` });
			if (profile_id) {
				const profile = db.prepare('SELECT id FROM decision_param_profiles WHERE id = ? AND decision_id = ?').get(profile_id, decision_id);
				if (!profile) return text({ error: `Profile ${profile_id} not found for decision ${decision_id}` });
				db.transaction(() => {
					db.prepare('UPDATE decision_param_profiles SET name = ? WHERE id = ?').run(name, profile_id);
					db.prepare('DELETE FROM decision_param_profile_values WHERE profile_id = ?').run(profile_id);
					const ins = db.prepare('INSERT INTO decision_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
					for (const v of values) ins.run(profile_id, v.param_name, v.value);
				})();
				return text({ updated: true, profile_id });
			} else {
				const r = db.transaction(() => {
					const res = db.prepare('INSERT INTO decision_param_profiles (decision_id, name) VALUES (?, ?)').run(decision_id, name);
					const newId = res.lastInsertRowid as number;
					const ins = db.prepare('INSERT INTO decision_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
					for (const v of values) ins.run(newId, v.param_name, v.value);
					return newId;
				})();
				return text({ created: true, profile_id: r });
			}
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// list_decision_profiles
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'list_decision_profiles',
		{
			description: 'Lists all parameter profiles for a decision, including their value overrides. Decision profiles are used in suite runs.',
			inputSchema: { decision_id: z.number().int() }
		},
		async ({ decision_id }) => {
			const db = getDb();
			const profiles = db.prepare('SELECT * FROM decision_param_profiles WHERE decision_id = ? ORDER BY id').all(decision_id) as { id: number; decision_id: number; name: string }[];
			const values = db.prepare('SELECT * FROM decision_param_profile_values WHERE profile_id IN (SELECT id FROM decision_param_profiles WHERE decision_id = ?) ORDER BY profile_id, id').all(decision_id) as { profile_id: number; param_name: string; value: string }[];
			const byProfile = new Map<number, { param_name: string; value: string }[]>();
			for (const v of values) {
				const arr = byProfile.get(v.profile_id) ?? [];
				arr.push({ param_name: v.param_name, value: v.value });
				byProfile.set(v.profile_id, arr);
			}
			return text(profiles.map(p => ({ ...p, values: byProfile.get(p.id) ?? [] })));
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// delete_decision_profile
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'delete_decision_profile',
		{
			description: 'Deletes a decision-level parameter profile by ID.',
			inputSchema: { profile_id: z.number().int() }
		},
		async ({ profile_id }) => {
			const db = getDb();
			db.prepare('DELETE FROM decision_param_profiles WHERE id = ?').run(profile_id);
			return text({ deleted: true, profile_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// upsert_profile
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'upsert_profile',
		{
			description: 'Creates or updates a named parameter profile for a design. Profiles let you run the same design at different scales (e.g. small/medium/large). Omit profile_id to create; provide it to update.',
			inputSchema: {
				design_id: z.number().int(),
				profile_id: z.number().int().optional().describe('Omit to create a new profile'),
				name: z.string().describe('Profile name, e.g. "small", "medium", "large"'),
				values: z.array(z.object({
					param_name: z.string().describe('Param name (must match a design param)'),
					value: z.string().describe('Override value for this profile')
				})).describe('Only include params you want to override from their defaults')
			}
		},
		async ({ design_id, profile_id, name, values }) => {
			const db = getDb();
			if (profile_id) {
				const profile = db.prepare('SELECT id FROM design_param_profiles WHERE id = ? AND design_id = ?').get(profile_id, design_id);
				if (!profile) return text({ error: `Profile ${profile_id} not found for design ${design_id}` });
				db.transaction(() => {
					db.prepare('UPDATE design_param_profiles SET name = ? WHERE id = ?').run(name, profile_id);
					db.prepare('DELETE FROM design_param_profile_values WHERE profile_id = ?').run(profile_id);
					const ins = db.prepare('INSERT INTO design_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
					for (const v of values) ins.run(profile_id, v.param_name, v.value);
				})();
				return text({ updated: true, profile_id });
			} else {
				const r = db.transaction(() => {
					const res = db.prepare('INSERT INTO design_param_profiles (design_id, name) VALUES (?, ?)').run(design_id, name);
					const newId = res.lastInsertRowid as number;
					const ins = db.prepare('INSERT INTO design_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
					for (const v of values) ins.run(newId, v.param_name, v.value);
					return newId;
				})();
				return text({ created: true, profile_id: r });
			}
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// list_profiles
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'list_profiles',
		{
			description: 'Lists all parameter profiles for a design, including their value overrides.',
			inputSchema: { design_id: z.number().int() }
		},
		async ({ design_id }) => {
			const db = getDb();
			const profiles = db.prepare('SELECT * FROM design_param_profiles WHERE design_id = ? ORDER BY id').all(design_id) as { id: number; design_id: number; name: string }[];
			const values = db.prepare('SELECT * FROM design_param_profile_values WHERE profile_id IN (SELECT id FROM design_param_profiles WHERE design_id = ?) ORDER BY profile_id, id').all(design_id) as { profile_id: number; param_name: string; value: string }[];
			const byProfile = new Map<number, { param_name: string; value: string }[]>();
			for (const v of values) {
				const arr = byProfile.get(v.profile_id) ?? [];
				arr.push({ param_name: v.param_name, value: v.value });
				byProfile.set(v.profile_id, arr);
			}
			return text(profiles.map(p => ({ ...p, values: byProfile.get(p.id) ?? [] })));
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// delete_profile
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'delete_profile',
		{
			description: 'Deletes a parameter profile by ID.',
			inputSchema: { profile_id: z.number().int() }
		},
		async ({ profile_id }) => {
			const db = getDb();
			db.prepare('DELETE FROM design_param_profiles WHERE id = ?').run(profile_id);
			return text({ deleted: true, profile_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// validate_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'validate_design',
		{
			description: `Validates a design and returns a list of issues that would prevent it from running correctly.
Checks performed:
  - No server configured
  - No database set
  - No enabled steps
  - No enabled bench step (pgbench or sysbench) — nothing to benchmark
  - pgbench step with no scripts defined
  - wait step with duration_secs = 0
  - perf step with no modes enabled (stat/record/trace)
  - perf step with a mode enabled but no duration set (perf_stat/record/trace_duration or shared perf_duration)
  - perf duration/delay/repeat/freq fields with invalid values (must be integer or {{PARAM}})
  - {{PARAM}} placeholders used in scripts/options but not defined in design params or inherited decision params
  - Defined params with empty values
Call this before run_design or export_plan to catch problems early.`,
			inputSchema: {
				design_id: z.number().int().describe('Design ID to validate'),
				server_id: z.number().int().optional().describe('Optional run-time server override to validate against'),
				database: z.string().optional().describe('Optional run-time database override to validate against')
			}
		},
		async ({ design_id, server_id, database }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id) as {
				id: number; name: string; server_id: number | null; database: string;
			} | undefined;
			if (!design) return text({ error: `Design ${design_id} not found` });
			const resolvedServerId = server_id ?? design.server_id;
			const resolvedDatabase = database ?? design.database;

			const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(design_id) as DesignStep[];
			const pgbenchScripts = db.prepare('SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position').all(design_id) as PgbenchScript[];
			const params = db.prepare('SELECT * FROM design_params WHERE design_id = ? ORDER BY position').all(design_id) as DesignParam[];

			// Load decision-level params so inherited {{PARAM}} refs are not flagged as undefined
			const designRow = db.prepare('SELECT decision_id FROM designs WHERE id = ?').get(design_id) as { decision_id: number } | undefined;
			const decisionParams = designRow?.decision_id
				? db.prepare('SELECT name FROM decision_params WHERE decision_id = ? ORDER BY position').all(designRow.decision_id) as { name: string }[]
				: [];

			const scriptsByStep = new Map<number, PgbenchScript[]>();
			for (const ps of pgbenchScripts) {
				const arr = scriptsByStep.get(ps.step_id) ?? [];
				arr.push(ps);
				scriptsByStep.set(ps.step_id, arr);
			}

			const issues: { severity: 'error' | 'warning'; code: string; message: string }[] = [];

			// Server and database checks
			if (!resolvedServerId) {
				issues.push({ severity: 'error', code: 'NO_SERVER', message: 'No PostgreSQL server configured. Use configure_design or pass server_id to validate_design/run_design.' });
			}
			if (!resolvedDatabase || resolvedDatabase.trim() === '') {
				issues.push({ severity: 'error', code: 'NO_DATABASE', message: 'No database name configured. Use configure_design or pass database to validate_design/run_design.' });
			}

			// Step checks
			const enabledSteps = steps.filter(s => s.enabled);
			if (enabledSteps.length === 0) {
				issues.push({ severity: 'error', code: 'NO_ENABLED_STEPS', message: 'No enabled steps. Enable at least one step before running.' });
			} else {
				const hasBenchStep = enabledSteps.some(s => s.type === 'pgbench' || s.type === 'sysbench');
				if (!hasBenchStep) {
					issues.push({ severity: 'warning', code: 'NO_BENCH_STEP', message: 'No enabled pgbench or sysbench step. The run will execute but produce no benchmark metrics (TPS, latency).' });
				}

				for (const step of enabledSteps) {
					if (step.type === 'pgbench') {
						const scripts = scriptsByStep.get(step.id) ?? [];
						const runnableScripts = getRunnablePgbenchScripts(scripts);
						if (runnableScripts.length === 0) {
							const message = scripts.length === 0
								? `pgbench step "${step.name}" has no scripts defined. It will run pgbench's built-in TPC-B scenario instead.`
								: `pgbench step "${step.name}" has no active scripts because all weights are 0. It will run pgbench's built-in TPC-B scenario instead.`;
							issues.push({ severity: 'warning', code: 'PGBENCH_NO_SCRIPTS', message });
						} else {
							const totalWeight = runnableScripts.reduce((sum, ps) => sum + (ps.weight ?? 1), 0);
							if (totalWeight > 100) {
								issues.push({ severity: 'error', code: 'PGBENCH_WEIGHT_EXCEEDS_100', message: `pgbench step "${step.name}" has scripts with a total weight of ${totalWeight}. Total weight must not exceed 100.` });
							}
						}
					}
					if (step.type === 'collect' && (!step.duration_secs || step.duration_secs <= 0)) {
						issues.push({ severity: 'warning', code: 'COLLECT_ZERO_DURATION', message: `wait step "${step.name}" has duration_secs = 0. It will use the design-level pre/post collect settings.` });
					}

					if (step.type === 'perf') {
						// Helper: a perf duration/delay/count field must be empty, a plain integer, or a single {{PARAM}}
						const isValidPerfField = (v: string) => v.trim() === '' || /^\d+$/.test(v.trim()) || /^\{\{[\w]+\}\}$/.test(v.trim());

						const noModesEnabled = !step.perf_stat_enabled && !step.perf_record_enabled && !step.perf_trace_enabled;
						if (noModesEnabled) {
							issues.push({ severity: 'warning', code: 'PERF_NO_MODES', message: `perf step "${step.name}" has no modes enabled (stat/record/trace). Enable at least one mode or remove the step.` });
						}

						for (const [mode, modeEnabled, modeSpecific, modeLabel] of [
							['stat',   step.perf_stat_enabled,   step.perf_stat_duration,   'stat duration'],
							['record', step.perf_record_enabled, step.perf_record_duration, 'record duration'],
							['trace',  step.perf_trace_enabled,  step.perf_trace_duration,  'trace duration'],
						] as [string, number | undefined, string | undefined, string][]) {
							const effective = modeSpecific || step.perf_duration || '';
							if (modeEnabled) {
								if (effective.trim() === '') {
									issues.push({ severity: 'error', code: 'PERF_DURATION_REQUIRED', message: `perf step "${step.name}": ${modeLabel} is required when ${mode} mode is enabled. Set perf_${mode}_duration or the shared perf_duration field.` });
								} else if (!isValidPerfField(effective)) {
									issues.push({ severity: 'error', code: 'PERF_DURATION_INVALID', message: `perf step "${step.name}": ${modeLabel} "${effective}" is not valid — must be a plain integer or {{PARAM_NAME}}.` });
								}
							} else if (!isValidPerfField(effective)) {
								issues.push({ severity: 'error', code: 'PERF_DURATION_INVALID', message: `perf step "${step.name}": ${modeLabel} "${effective}" is not valid — must be a plain integer or {{PARAM_NAME}}.` });
							}
						}

						for (const [mode, modeSpecific] of [
							['stat',   step.perf_stat_delay],
							['record', step.perf_record_delay],
							['trace',  step.perf_trace_delay],
						] as [string, string | undefined][]) {
							const effective = modeSpecific || step.perf_delay || '';
							if (!isValidPerfField(effective)) {
								issues.push({ severity: 'error', code: 'PERF_DELAY_INVALID', message: `perf step "${step.name}": ${mode} delay "${effective}" is not valid — must be a plain integer or {{PARAM_NAME}}.` });
							}
						}

						if (step.perf_repeat && !isValidPerfField(step.perf_repeat)) {
							issues.push({ severity: 'error', code: 'PERF_REPEAT_INVALID', message: `perf step "${step.name}": repeat "${step.perf_repeat}" is not valid — must be a plain integer or {{PARAM_NAME}}.` });
						}
						if (step.perf_freq && !isValidPerfField(step.perf_freq)) {
							issues.push({ severity: 'error', code: 'PERF_FREQ_INVALID', message: `perf step "${step.name}": frequency "${step.perf_freq}" is not valid — must be a plain integer or {{PARAM_NAME}}.` });
						}
					}
				}
			}

			// Param placeholder checks — include decision-level inherited params
			const definedParams = new Set([
				...decisionParams.map(p => p.name),
				...params.map(p => p.name)
			].filter(Boolean));
			const placeholderPattern = /\{\{([\w]+)\}\}/g;

			for (const step of enabledSteps) {
				const textsToCheck: { label: string; text: string }[] = [];

				if (step.type === 'sql' && step.script) {
					textsToCheck.push({ label: `script`, text: step.script });
				}
				if (step.type === 'pgbench') {
					if (step.pgbench_options) textsToCheck.push({ label: `pgbench_options`, text: step.pgbench_options });
					for (const ps of getRunnablePgbenchScripts(scriptsByStep.get(step.id) ?? [])) {
						textsToCheck.push({ label: `script "${ps.name}"`, text: ps.script });
					}
				}

				for (const { label, text: scriptText } of textsToCheck) {
					const matches = [...scriptText.matchAll(placeholderPattern)].map(m => m[1]);
					for (const ph of matches) {
						if (!definedParams.has(ph)) {
							issues.push({
								severity: 'error',
								code: 'UNDEFINED_PARAM',
								message: `Step "${step.name}" ${label} uses {{${ph}}} but this param is not defined. Add it with set_params.`
							});
						}
					}
				}
			}

			// Param value checks
			for (const p of params) {
				if (!p.value || p.value.trim() === '') {
					issues.push({ severity: 'warning', code: 'EMPTY_PARAM_VALUE', message: `Param "${p.name}" has an empty value. Steps using {{${p.name}}} will substitute an empty string.` });
				}
			}

			const errorCount = issues.filter(i => i.severity === 'error').length;
			const warningCount = issues.filter(i => i.severity === 'warning').length;

			return text({
				design_id,
				design_name: design.name,
				resolved_server_id: resolvedServerId,
				resolved_database: resolvedDatabase,
				valid: errorCount === 0,
				summary: errorCount === 0 && warningCount === 0
					? 'No issues found. Design is ready to run.'
					: `${errorCount} error(s), ${warningCount} warning(s) found.`,
				issues
			});
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// run_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'run_design',
		{
			description: `Starts a benchmark run for a design. Returns run_id immediately — poll get_run(run_id) until status is "completed" or "failed".
Executes all enabled steps in order: sql setup → wait → pgbench → wait → sql teardown.
Optional query-level steps can be inserted anywhere: pg_stat_statements_reset and pg_stat_statements_collect.
By default this runs locally. If ec2_server_id is provided, it launches the run on that EC2 runner instead.
You can override server_id, database, and snapshot_interval_seconds for either run location.
This is a validation/test run. For production benchmarking, use export_plan + mybench-runner on EC2.

Polling strategy: before polling, estimate total run duration from the design steps:
- For each pgbench step: parse the -T <seconds> flag from pgbench_options (e.g. "-T 60" → 60s)
- For each wait step: add duration_secs
- Sum all steps, then wait that long before the first get_run call
- If still "running", poll every ~30s thereafter
Example: pgbench -T 120 + two 15s wait steps → wait ~150s before first poll.`,
			inputSchema: {
				design_id: z.number().int(),
				server_id: z.number().int().optional().describe('Optional run-time PostgreSQL server override'),
				database: z.string().optional().describe('Optional run-time database override'),
				snapshot_interval_seconds: z.number().int().optional().describe('Optional run-time pg_stat_* snapshot interval override'),
				profile_id: z.number().int().optional().describe('Optional profile ID to apply param overrides'),
				name: z.string().optional().describe('Optional run name; defaults to profile name if a profile is used'),
				ec2_server_id: z.number().int().describe('EC2 runner ID from get_context ec2_servers. Required — use list_ec2_servers to find available runners.')
			}
		},
		async ({ design_id, server_id, database, snapshot_interval_seconds, profile_id, name, ec2_server_id }) => {
			if (!ec2_server_id) {
				return text({ error: 'ec2_server_id is required. Local runs are no longer supported. Use list_ec2_servers to find an available runner.' });
			}
			const runId = startEc2Run(design_id, ec2_server_id, { server_id, database, snapshot_interval_seconds, profile_id, name });
			return text({ run_id: runId, message: 'Run started. Poll get_run(run_id) for status.' });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_run
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'get_run',
		{
			description: `Returns the current status and results of a benchmark run. Poll this after run_design.
status: "running" | "completed" | "failed" | "stopped"
When completed: tps, latency_avg_ms, latency_stddev_ms, and transactions are populated.

Do NOT poll rapidly. Estimate the run duration first (see run_design description), wait that long,
then poll every ~30s if still running. Rapid polling wastes resources and does not speed up the run.`,
			inputSchema: { run_id: z.number().int() }
		},
		async ({ run_id }) => {
			const db = getDb();
			const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(run_id) as Record<string, unknown> | undefined;
			if (!run) return text({ error: `Run ${run_id} not found` });
			// Parse run_params from JSON string for easier consumption
			const runParams = run.run_params && typeof run.run_params === 'string' && run.run_params !== ''
				? (() => { try { return JSON.parse(run.run_params as string); } catch { return []; } })()
				: [];
			return text({ ...run, run_params: runParams });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// export_plan
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'export_plan',
		{
			description: `Returns the plan.json for a design — the input file for mybench-runner on EC2.
Contains: server config, all enabled steps + scripts, params, and pg_stat table specs.
Use this after validating the plan with run_design.`,
			inputSchema: { design_id: z.number().int() }
		},
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id) as {
				id: number; name: string; server_id: number | null; database: string;
				pre_collect_secs: number; post_collect_secs: number; snapshot_interval_seconds: number;
			} | undefined;
			if (!design) return text({ error: `Design ${design_id} not found` });

			const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position').all(design_id) as DesignStep[];
			const pgbenchScripts = db.prepare('SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ? AND enabled = 1) ORDER BY step_id, position').all(design_id) as PgbenchScript[];
			const scriptsByStep = new Map<number, PgbenchScript[]>();
			for (const ps of pgbenchScripts) {
				const arr = scriptsByStep.get(ps.step_id) ?? [];
				arr.push(ps);
				scriptsByStep.set(ps.step_id, arr);
			}
			const params = db.prepare('SELECT * FROM design_params WHERE design_id = ? ORDER BY position').all(design_id) as DesignParam[];

			const profileRows = db.prepare('SELECT * FROM design_param_profiles WHERE design_id = ? ORDER BY id').all(design_id) as { id: number; name: string }[];
			const profileValueRows = db.prepare('SELECT * FROM design_param_profile_values WHERE profile_id IN (SELECT id FROM design_param_profiles WHERE design_id = ?) ORDER BY profile_id, id').all(design_id) as { profile_id: number; param_name: string; value: string }[];
			const profileValuesById = new Map<number, { param_name: string; value: string }[]>();
			for (const v of profileValueRows) {
				const arr = profileValuesById.get(v.profile_id) ?? [];
				arr.push({ param_name: v.param_name, value: v.value });
				profileValuesById.set(v.profile_id, arr);
			}
			const profiles = profileRows.map(p => ({ name: p.name, values: profileValuesById.get(p.id) ?? [] }));

			let serverInfo = { host: '', port: 5432, username: '', password: '', database: design.database, ssl: false, perf_enabled: false, perf_scope: 'disabled', perf_cgroup: '', perf_events: '' };
			if (design.server_id) {
				const srv = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(design.server_id) as PgServer | undefined;
				if (srv) serverInfo = { host: srv.host, port: srv.port, username: srv.username, password: srv.password, database: design.database, ssl: !!srv.ssl, perf_enabled: !!srv.perf_enabled, perf_scope: srv.perf_scope, perf_cgroup: srv.perf_cgroup, perf_events: srv.perf_events };
			}

			const enabledSnapTables: { pg_view_name: string; snap_table_name: string; columns: string[] }[] = [];
			for (const table_name of Object.keys(SNAP_TABLE_MAP)) {
				const snapTable = SNAP_TABLE_MAP[table_name];
				if (!snapTable) continue;
				let cols: string[] = [];
				try { cols = (db.prepare(`PRAGMA table_info(${snapTable})`).all() as { name: string }[]).map(r => r.name).filter(n => !EXCLUDED_SNAP_COLS.has(n)); } catch { /* not yet created */ }
				enabledSnapTables.push({ pg_view_name: table_name, snap_table_name: snapTable, columns: cols });
			}
			if (steps.some((step) => step.type === 'pg_stat_statements_collect')) {
				let cols: string[] = [];
				try {
					cols = (db.prepare(`PRAGMA table_info(snap_pg_stat_statements)`).all() as { name: string }[])
						.map((r) => r.name)
						.filter((n) => !EXCLUDED_SNAP_COLS.has(n));
				} catch {
					// table not yet created
				}
				enabledSnapTables.push({
					pg_view_name: 'pg_stat_statements',
					snap_table_name: 'snap_pg_stat_statements',
					columns: cols
				});
			}

			return text({
				version: 1,
				exported_at: new Date().toISOString(),
				design_id: design.id,
				design_name: design.name,
				server: serverInfo,
				run_settings: { snapshot_interval_seconds: design.snapshot_interval_seconds, pre_collect_secs: design.pre_collect_secs, post_collect_secs: design.post_collect_secs },
				params: params.map(p => ({ name: p.name, value: p.value })),
				profiles,
				steps: steps.map(s => s.type === 'perf' ? ({
					id: s.id, position: s.position, name: s.name, type: s.type, enabled: !!s.enabled,
					perf_stat_enabled: !!s.perf_stat_enabled,
					perf_record_enabled: !!s.perf_record_enabled,
					perf_trace_enabled: !!s.perf_trace_enabled,
					perf_events: s.perf_events ?? '',
					perf_duration: s.perf_duration ?? '',
					perf_stat_duration: s.perf_stat_duration ?? '',
					perf_record_duration: s.perf_record_duration ?? '',
					perf_trace_duration: s.perf_trace_duration ?? '',
					perf_delay: s.perf_delay ?? '',
					perf_stat_delay: s.perf_stat_delay ?? '',
					perf_record_delay: s.perf_record_delay ?? '',
					perf_trace_delay: s.perf_trace_delay ?? '',
					perf_cgroup: s.perf_cgroup ?? '',
					perf_repeat: s.perf_repeat ?? '',
					perf_freq: s.perf_freq ?? '',
					perf_call_graph: s.perf_call_graph ?? 'dwarf',
					perf_mmap_pages: s.perf_mmap_pages ?? ''
				}) : ({
					id: s.id, position: s.position, name: s.name, type: s.type, enabled: !!s.enabled,
					script: s.script, no_transaction: !!s.no_transaction, duration_secs: s.duration_secs,
					pgbench_options: s.pgbench_options,
					pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []).map(ps => ({ id: ps.id, name: ps.name, weight: ps.weight, script: ps.script })) : []
				})),
				enabled_snap_tables: enabledSnapTables
			});
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_collected_data_schema
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'get_collected_data_schema',
		{
			description: `Returns the schema of all collected-data tables in the mybench SQLite database.
Use this before writing queries with query_run_data to understand what columns are available.

Includes:
- snap_* tables: PostgreSQL statistics snapshots (pg_stat_database, pg_stat_user_tables, pg_stat_wal, pg_locks, pg_stat_statements, etc.)
- host_snap_* tables: OS/host metrics (CPU, memory, disk I/O, network, per-process stats)
- benchmark_runs, designs, decisions: core metadata for filtering by run/design/decision

All snap_* and host_snap_* tables share these standard columns:
- _run_id: foreign key to benchmark_runs.id — use this to filter snapshots for a specific run
- _collected_at: ISO timestamp of when the snapshot was taken
- _phase: "pre" | "bench" | "post" — which collection phase this snapshot belongs to

The delta pattern for cumulative counters: subtract the first snapshot value from the last within a phase.
Example: wal_bytes written during benchmark = MAX(wal_bytes) - MIN(wal_bytes) WHERE _run_id=? AND _phase='bench'`
		},
		() => {
			const db = getDb();

			const tableNames = (db.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'snap_%' OR name LIKE 'host_snap_%') ORDER BY name`
			).all() as { name: string }[]).map(r => r.name);

			const snapSchema: Record<string, { name: string; type: string }[]> = {};
			for (const tbl of tableNames) {
				const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string; cid: number; type: string }[];
				snapSchema[tbl] = cols.map(c => ({ name: c.name, type: c.type || 'TEXT' }));
			}

			const coreTableDefs: Record<string, { name: string; type: string }[]> = {};
			for (const tbl of ['benchmark_runs', 'designs', 'decisions']) {
				const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string; cid: number; type: string }[];
				coreTableDefs[tbl] = cols.map(c => ({ name: c.name, type: c.type || 'TEXT' }));
			}

			return text({
				standard_snap_columns: {
					_run_id: 'INTEGER — foreign key to benchmark_runs.id',
					_collected_at: 'TEXT — ISO timestamp of snapshot',
					_phase: 'TEXT — "pre" | "bench" | "post"'
				},
				core_tables: coreTableDefs,
				snap_tables: snapSchema
			});
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// query_run_data
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'query_run_data',
		{
			description: `Executes a read-only SQL query against the mybench SQLite database and returns the results.
Use get_collected_data_schema first to understand available tables and columns.

Useful patterns:
- Filter snapshots by run: WHERE _run_id = ?  (pass run_id in params)
- Compare two runs: WHERE _run_id IN (?, ?)
- Delta for cumulative counters within bench phase: MAX(col) - MIN(col) WHERE _run_id=? AND _phase='bench'
- Join to designs/decisions: JOIN benchmark_runs br ON snap._run_id = br.id JOIN designs d ON br.design_id = d.id

Only SELECT and WITH statements are allowed. Results are capped at 500 rows.`,
			inputSchema: {
				sql: z.string().describe('SELECT or WITH query to execute'),
				params: z.array(z.union([z.string(), z.number(), z.null()])).optional().describe('Positional parameters for ? placeholders in the SQL')
			}
		},
		({ sql, params = [] }) => {
			const normalized = sql.trim().toUpperCase();
			if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
				return text({ error: 'Only SELECT and WITH queries are allowed' });
			}

			const db = getDb();
			try {
				const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
				const limited = rows.slice(0, 500);
				const columns = limited.length > 0 ? Object.keys(limited[0]) : [];
				return text({
					columns,
					rows: limited,
					row_count: limited.length,
					truncated: rows.length > 500 ? rows.length : undefined
				});
			} catch (err) {
				return text({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_db_schema
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'get_db_schema',
		{
			description: `Queries the live PostgreSQL database for the design's server and returns all tables with their columns and types.
Call this before writing SQL steps — you need the real table and column names.
Returns tables in the "public" schema. If no server is configured for the design, set one with configure_design first.`,
			inputSchema: { design_id: z.number().int().describe('Design ID — used to look up the configured PG server') }
		},
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT server_id, database FROM designs WHERE id = ?').get(design_id) as { server_id: number | null; database: string } | undefined;
			if (!design?.server_id) return text({ error: 'No server configured for this design. Set one with configure_design first.' });

			const srv = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(design.server_id) as PgServer | undefined;
			if (!srv) return text({ error: `Server ${design.server_id} not found` });

			const pool = createPool(srv, design.database);
			try {
				const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(`
					SELECT table_name, column_name, data_type
					FROM information_schema.columns
					WHERE table_schema = 'public'
					ORDER BY table_name, ordinal_position
				`);
				const tables: Record<string, { name: string; type: string }[]> = {};
				for (const row of rows) (tables[row.table_name] ??= []).push({ name: row.column_name, type: row.data_type });
				return text({ database: design.database, server: srv.name, tables });
			} finally {
				await pool.end().catch(() => {});
			}
		}
	);
}
