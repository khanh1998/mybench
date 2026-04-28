import getDb from '$lib/server/db';
import { getPgStatStatementsSqliteType } from '$lib/server/pg-stat-statements-schema';

export interface RunnerResultRun {
	status: string;
	started_at: string;
	finished_at: string;
	database?: string;
	bench_started_at?: string;
	post_started_at?: string;
	snapshot_interval_seconds?: number;
	pre_collect_secs?: number;
	post_collect_secs?: number;
	tps?: number;
	latency_avg_ms?: number;
	latency_stddev_ms?: number;
	transactions?: number;
	profile_name?: string;
	params?: Array<{ name: string; value: string }>;
}

export interface RunnerResultStep {
	step_id: number;
	position: number;
	name: string;
	type: string;
	status: string;
	command?: string;
	log?: string;
	processed_script?: string;
	pgbench_summary?: {
		tps?: number;
		latency_avg_ms?: number;
		latency_stddev_ms?: number;
		transactions?: number;
		failed_transactions?: number;
		transaction_type?: string;
		scaling_factor?: number;
		query_mode?: string;
		number_of_clients?: number;
		number_of_threads?: number;
		maximum_tries?: number;
		duration_secs?: number;
		initial_connection_time_ms?: number;
	};
	pgbench_scripts?: Array<{
		position: number;
		name: string;
		weight?: number;
		script?: string;
		tps?: number;
		latency_avg_ms?: number;
		latency_stddev_ms?: number;
		transactions?: number;
		failed_transactions?: number;
	}>;
	sysbench_summary?: {
		tps?: number;
		qps?: number;
		latency_avg_ms?: number;
		latency_min_ms?: number;
		latency_max_ms?: number;
		latency_p95_ms?: number | null;
		total_time_secs?: number;
		total_events?: number;
		transactions?: number;
		errors?: number;
		threads?: number;
		queries_read?: number;
		queries_write?: number;
		queries_other?: number;
		queries_total?: number;
		reconnects?: number;
		rows_per_sec?: number | null;
	};
	perf?: RunnerPerfResult;
	started_at: string;
	finished_at: string;
}

export interface RunnerPerfEvent {
	event_name: string;
	counter_value?: number | null;
	unit?: string;
	runtime_secs?: number | null;
	percent_running?: number | null;
	per_transaction?: number | null;
	derived_value?: number | null;
	derived_unit?: string;
}

export interface RunnerPerfResult {
	status: string;
	scope: string;
	cgroup?: string;
	command?: string;
	raw_output?: string;
	raw_error?: string;
	warnings?: string[];
	started_at?: string;
	finished_at?: string;
	events?: RunnerPerfEvent[];
}

export interface RunnerResult {
	run: RunnerResultRun;
	steps?: RunnerResultStep[];
	snapshots?: Record<string, Record<string, unknown>[]>;
	cloudwatch_metrics?: {
		data_points?: Array<{ metric_name: string; timestamp: string; value: number; unit: string }>;
	};
	host_snapshots?: Record<string, Record<string, unknown>[]>;
	host_config?: Record<string, unknown>;
}

function normalizeSqliteValue(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (
		typeof value === 'number' ||
		typeof value === 'string' ||
		typeof value === 'bigint' ||
		value === null ||
		value === undefined
	) {
		return value ?? null;
	}
	return JSON.stringify(value);
}

/**
 * Writes runner result data INTO an already-existing benchmark_runs row.
 * Deletes any existing run_step_results for the run first, then inserts real ones.
 * Used by EC2 executor after remote execution completes.
 */
export function importResultIntoRun(runId: number, result: RunnerResult): void {
	const db = getDb();
	const run = result.run;
	const existingRun = db.prepare('SELECT database FROM benchmark_runs WHERE id = ?').get(runId) as { database: string } | undefined;
	const resolvedDatabase = run.database ?? existingRun?.database ?? '';

	// Update the benchmark_runs row with result data
	db.prepare(`
		UPDATE benchmark_runs SET
			database = ?,
			status = ?,
			started_at = ?,
			finished_at = ?,
			bench_started_at = ?,
			post_started_at = ?,
			snapshot_interval_seconds = ?,
			pre_collect_secs = ?,
			post_collect_secs = ?,
			tps = ?,
			latency_avg_ms = ?,
			latency_stddev_ms = ?,
			transactions = ?,
			profile_name = ?,
			run_params = ?
		WHERE id = ?
	`).run(
		resolvedDatabase,
		run.status ?? 'completed',
		run.started_at ?? new Date().toISOString(),
		run.finished_at ?? new Date().toISOString(),
		run.bench_started_at ?? null,
		run.post_started_at ?? null,
		run.snapshot_interval_seconds ?? 30,
		run.pre_collect_secs ?? 0,
		run.post_collect_secs ?? 60,
		run.tps ?? null,
		run.latency_avg_ms ?? null,
		run.latency_stddev_ms ?? null,
		run.transactions ?? null,
		run.profile_name ?? '',
		run.params ? JSON.stringify(run.params) : '',
		runId
	);

	// Replace step results: delete placeholder(s), insert real ones
	db.prepare('DELETE FROM run_step_results WHERE run_id = ?').run(runId);
	db.prepare('DELETE FROM run_step_perf WHERE run_id = ?').run(runId);
	db.prepare('DELETE FROM run_step_perf_events WHERE run_id = ?').run(runId);

	const steps = result.steps;
	if (steps?.length) {
		const insStep = db.prepare(`
			INSERT INTO run_step_results (
				run_id, step_id, position, name, type, status, command, stdout,
				processed_script, pgbench_summary_json, pgbench_scripts_json,
				sysbench_summary_json, started_at, finished_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insPerf = db.prepare(`
			INSERT INTO run_step_perf (
				run_id, step_id, status, scope, cgroup, command, raw_output, raw_error,
				warnings_json, started_at, finished_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insPerfEvent = db.prepare(`
			INSERT INTO run_step_perf_events (
				run_id, step_id, event_name, counter_value, unit, runtime_secs, percent_running, per_transaction,
				derived_value, derived_unit
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		db.transaction(() => {
			for (const s of steps) {
				insStep.run(
					runId,
					s.step_id,
					s.position,
					s.name,
					s.type,
					s.status,
					s.command ?? '',
					s.log ?? '',
					s.processed_script ?? '',
					s.pgbench_summary ? JSON.stringify(s.pgbench_summary) : '',
					s.pgbench_scripts ? JSON.stringify(s.pgbench_scripts) : '',
					s.sysbench_summary ? JSON.stringify(s.sysbench_summary) : '',
					s.started_at,
					s.finished_at
				);
				if (s.perf) {
					insPerf.run(
						runId,
						s.step_id,
						s.perf.status ?? '',
						s.perf.scope ?? 'disabled',
						s.perf.cgroup ?? '',
						s.perf.command ?? '',
						s.perf.raw_output ?? '',
						s.perf.raw_error ?? '',
						s.perf.warnings ? JSON.stringify(s.perf.warnings) : '',
						s.perf.started_at ?? null,
						s.perf.finished_at ?? null
					);
					for (const ev of s.perf.events ?? []) {
						insPerfEvent.run(
							runId,
							s.step_id,
							ev.event_name,
							ev.counter_value ?? null,
							ev.unit ?? '',
							ev.runtime_secs ?? null,
							ev.percent_running ?? null,
							ev.per_transaction ?? null,
							ev.derived_value ?? null,
							ev.derived_unit ?? ''
						);
					}
				}
			}
		})();
	}

	// Insert snapshots
	const snapshots = result.snapshots;
	if (snapshots) {
		for (const [snapTableName, rows] of Object.entries(snapshots)) {
			if (!Array.isArray(rows) || rows.length === 0) continue;

			db.exec(`CREATE TABLE IF NOT EXISTS ${snapTableName} (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER
			)`);

			const existingCols = new Set(
				(db.prepare(`PRAGMA table_info(${snapTableName})`).all() as { name: string }[]).map(r => r.name)
			);

			const metaCols = new Set(['_collected_at', '_phase', '_is_baseline', '_step_id']);
			const firstRow = rows[0];
			const rowMetaCols = ['_collected_at', ...Object.keys(firstRow).filter(k => k !== '_collected_at' && metaCols.has(k))];
			const dataCols = Object.keys(firstRow).filter(k => !metaCols.has(k));

			for (const col of rowMetaCols) {
				if (!existingCols.has(col)) {
					const columnType = col === '_step_id' ? 'INTEGER' : 'TEXT';
					db.exec(`ALTER TABLE ${snapTableName} ADD COLUMN ${col} ${columnType}`);
				}
			}

			for (const col of dataCols) {
				if (!existingCols.has(col)) {
					const columnType = snapTableName === 'snap_pg_stat_statements'
						? getPgStatStatementsSqliteType(col)
						: 'TEXT';
					db.exec(`ALTER TABLE ${snapTableName} ADD COLUMN ${col} ${columnType}`);
				}
			}

			const insertCols = ['_run_id', ...rowMetaCols, ...dataCols];
			const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
			const stmt = db.prepare(
				`INSERT INTO ${snapTableName} (${insertCols.join(', ')}) VALUES (${placeholders})`
			);

			const insertMany = db.transaction((rowsToInsert: Record<string, unknown>[]) => {
				for (const row of rowsToInsert) {
					const params: Record<string, unknown> = { p0: runId };
					rowMetaCols.forEach((col, i) => {
						if (col === '_collected_at') {
							params[`p${i + 1}`] = normalizeSqliteValue(row[col] ?? new Date().toISOString());
						} else {
							params[`p${i + 1}`] = normalizeSqliteValue(row[col]);
						}
					});
					dataCols.forEach((col, i) => {
						params[`p${i + rowMetaCols.length + 1}`] = normalizeSqliteValue(row[col]);
					});
					stmt.run(params);
				}
			});

			insertMany(rows);
		}
	}

	// Insert CloudWatch data points, tagging each with its phase by comparing
	// the data point timestamp against bench_started_at / post_started_at.
	const benchStartedAt = result.run.bench_started_at ?? null;
	const postStartedAt = result.run.post_started_at ?? null;
	const cwPhase = (ts: string): string => {
		if (!benchStartedAt || ts < benchStartedAt) return 'pre';
		if (!postStartedAt || ts < postStartedAt) return 'bench';
		return 'post';
	};
	const ins = db.prepare(
		`INSERT INTO cloudwatch_datapoints (run_id, metric_name, timestamp, value, unit, phase) VALUES (?, ?, ?, ?, ?, ?)`
	);

	const cwDataPoints = result.cloudwatch_metrics?.data_points;
	if (cwDataPoints && cwDataPoints.length > 0) {
		db.transaction(() => {
			for (const dp of cwDataPoints) {
				ins.run(runId, dp.metric_name, dp.timestamp, dp.value, dp.unit ?? '', cwPhase(dp.timestamp));
			}
		})();
	}

	// Import host_snapshots into host_snap_* tables (same dynamic-column pattern as snapshots).
	const hostSnapshots = result.host_snapshots;
	if (hostSnapshots) {
		for (const [tableName, rows] of Object.entries(hostSnapshots)) {
			if (!Array.isArray(rows) || rows.length === 0) continue;
			if (!tableName.startsWith('host_snap_')) continue;

			db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER
			)`);

			const existingCols = new Set(
				(db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]).map(r => r.name)
			);

			const metaCols = new Set(['_collected_at']);
			const firstRow = rows[0];
			const dataCols = Object.keys(firstRow).filter(k => k !== '_collected_at' && !metaCols.has(k));

			if (!existingCols.has('_collected_at')) {
				db.exec(`ALTER TABLE ${tableName} ADD COLUMN _collected_at TEXT`);
			}

			for (const col of dataCols) {
				if (existingCols.has(col)) continue;
				const colType = hostSnapColumnType(tableName, col);
				db.exec(`ALTER TABLE ${tableName} ADD COLUMN "${col}" ${colType}`);
			}

			const insertCols = ['_run_id', '_collected_at', ...dataCols];
			const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
			const stmt = db.prepare(
				`INSERT INTO ${tableName} (${insertCols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`
			);

			db.transaction((rowsToInsert: Record<string, unknown>[]) => {
				for (const row of rowsToInsert) {
					const params: Record<string, unknown> = {
						p0: runId,
						p1: normalizeSqliteValue(row['_collected_at'] ?? new Date().toISOString())
					};
					dataCols.forEach((col, i) => {
						params[`p${i + 2}`] = normalizeSqliteValue(row[col]);
					});
					stmt.run(params);
				}
			})(rows);
		}
	}

	// Import host_config as JSON into benchmark_runs.host_config.
	if (result.host_config && Object.keys(result.host_config).length > 0) {
		db.prepare(`UPDATE benchmark_runs SET host_config = ? WHERE id = ?`)
			.run(JSON.stringify(result.host_config), runId);
	}
}

function hostSnapColumnType(tableName: string, colName: string): string {
	// Known text discriminator columns
	const textCols = new Set(['device', 'iface', 'comm', 'state', 'name', 'cpu_id', 'wchan']);
	if (textCols.has(colName)) return 'TEXT';
	// PSI values and load averages are REAL
	if (tableName === 'host_snap_proc_psi') return 'REAL';
	if (tableName === 'host_snap_proc_loadavg' && (colName === 'load1' || colName === 'load5' || colName === 'load15')) return 'REAL';
	return 'INTEGER';
}

/**
 * Creates a new benchmark_runs row (is_imported=1) and populates it from the result.
 * Used by the /api/runs/import HTTP endpoint.
 * Returns the new run_id.
 */
export function importRun(designId: number, result: RunnerResult): number {
	const db = getDb();
	const run = result.run;
	const design = db.prepare('SELECT database FROM designs WHERE id = ?').get(Number(designId)) as { database: string } | undefined;
	const resolvedDatabase = run.database ?? design?.database ?? '';

	const insertResult = db.prepare(`
		INSERT INTO benchmark_runs (
			design_id, database, status, started_at, finished_at,
			bench_started_at, post_started_at,
			snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
			tps, latency_avg_ms, latency_stddev_ms, transactions,
			is_imported, profile_name, run_params
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
	`).run(
		Number(designId),
		resolvedDatabase,
		run.status ?? 'completed',
		run.started_at ?? new Date().toISOString(),
		run.finished_at ?? new Date().toISOString(),
		run.bench_started_at ?? null,
		run.post_started_at ?? null,
		run.snapshot_interval_seconds ?? 30,
		run.pre_collect_secs ?? 0,
		run.post_collect_secs ?? 60,
		run.tps ?? null,
		run.latency_avg_ms ?? null,
		run.latency_stddev_ms ?? null,
		run.transactions ?? null,
		run.profile_name ?? '',
		run.params ? JSON.stringify(run.params) : ''
	);

	const runId = insertResult.lastInsertRowid as number;
	importResultIntoRun(runId, result);
	return runId;
}
