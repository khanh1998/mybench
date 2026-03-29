import getDb from '$lib/server/db';
import { getPgStatStatementsSqliteType } from '$lib/server/pg-stat-statements-schema';

export interface RunnerResultRun {
	status: string;
	started_at: string;
	finished_at: string;
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
	started_at: string;
	finished_at: string;
}

export interface RunnerResult {
	run: RunnerResultRun;
	steps?: RunnerResultStep[];
	snapshots?: Record<string, Record<string, unknown>[]>;
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

	// Update the benchmark_runs row with result data
	db.prepare(`
		UPDATE benchmark_runs SET
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

	const steps = result.steps;
	if (steps?.length) {
		const insStep = db.prepare(`
			INSERT INTO run_step_results (run_id, step_id, position, name, type, status, command, stdout, started_at, finished_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		db.transaction(() => {
			for (const s of steps) {
				insStep.run(runId, s.step_id, s.position, s.name, s.type, s.status, s.command ?? '', s.log ?? '', s.started_at, s.finished_at);
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
}

/**
 * Creates a new benchmark_runs row (is_imported=1) and populates it from the result.
 * Used by the /api/runs/import HTTP endpoint.
 * Returns the new run_id.
 */
export function importRun(designId: number, result: RunnerResult): number {
	const db = getDb();
	const run = result.run;

	const insertResult = db.prepare(`
		INSERT INTO benchmark_runs (
			design_id, status, started_at, finished_at,
			bench_started_at, post_started_at,
			snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
			tps, latency_avg_ms, latency_stddev_ms, transactions,
			is_imported, profile_name, run_params
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
	`).run(
		Number(designId),
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
