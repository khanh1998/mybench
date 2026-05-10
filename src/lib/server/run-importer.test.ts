import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getPgStatStatementsSqliteType } from '$lib/server/pg-stat-statements-schema';

// ---------------------------------------------------------------------------
// Schema — mirrors what db.ts creates for the tables used by importResultIntoRun
// ---------------------------------------------------------------------------

function createTestDb() {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(`
		CREATE TABLE benchmark_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			design_id INTEGER NOT NULL DEFAULT 0,
			database TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'running',
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			finished_at TEXT,
			snapshot_interval_seconds INTEGER NOT NULL DEFAULT 30,
			pre_collect_secs INTEGER NOT NULL DEFAULT 0,
			post_collect_secs INTEGER NOT NULL DEFAULT 60,
			bench_started_at TEXT,
			post_started_at TEXT,
			tps REAL,
			latency_avg_ms REAL,
			latency_stddev_ms REAL,
			transactions INTEGER,
			is_imported INTEGER NOT NULL DEFAULT 0,
			name TEXT NOT NULL DEFAULT '',
			profile_name TEXT NOT NULL DEFAULT '',
			run_params TEXT NOT NULL DEFAULT '',
			ec2_server_id INTEGER,
			ec2_run_token TEXT NOT NULL DEFAULT '',
			series_id INTEGER,
			cli_log TEXT NOT NULL DEFAULT '',
			exec_log_path TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE run_step_results (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
			step_id INTEGER NOT NULL,
			position INTEGER NOT NULL DEFAULT 0,
			name TEXT NOT NULL,
			type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			stdout TEXT NOT NULL DEFAULT '',
			stderr TEXT NOT NULL DEFAULT '',
			exit_code INTEGER,
			started_at TEXT,
			finished_at TEXT,
			command TEXT NOT NULL DEFAULT '',
			processed_script TEXT NOT NULL DEFAULT '',
			pgbench_summary_json TEXT NOT NULL DEFAULT '',
			pgbench_scripts_json TEXT NOT NULL DEFAULT '',
			sysbench_summary_json TEXT NOT NULL DEFAULT '',
			output_file TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE run_step_perf (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
			step_id INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT '',
			scope TEXT NOT NULL DEFAULT 'disabled',
			cgroup TEXT NOT NULL DEFAULT '',
			command TEXT NOT NULL DEFAULT '',
			raw_output TEXT NOT NULL DEFAULT '',
			raw_error TEXT NOT NULL DEFAULT '',
			warnings_json TEXT NOT NULL DEFAULT '',
			started_at TEXT,
			finished_at TEXT
		);
		CREATE TABLE run_step_perf_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
			step_id INTEGER NOT NULL,
			event_name TEXT NOT NULL,
			counter_value REAL,
			unit TEXT NOT NULL DEFAULT '',
			runtime_secs REAL,
			percent_running REAL,
			per_transaction REAL,
			derived_value REAL,
			derived_unit TEXT NOT NULL DEFAULT ''
		);
	`);
	return db;
}

// ---------------------------------------------------------------------------
// importResultIntoRun logic — mirrors src/lib/server/run-importer.ts
// This is intentionally duplicated so we can test it against an in-memory DB.
// ---------------------------------------------------------------------------

function normalizeSqliteValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	return value;
}

interface RunnerResult {
	run: {
		status?: string;
		started_at?: string;
		finished_at?: string;
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
	};
	steps?: Array<{
		step_id: number;
		position: number;
		name: string;
		type: string;
		status: string;
		command?: string;
		log?: string;
		processed_script?: string;
		pgbench_summary?: Record<string, unknown>;
		pgbench_scripts?: unknown[];
		sysbench_summary?: Record<string, unknown>;
		started_at: string;
		finished_at: string;
	}>;
	snapshots?: Record<string, Record<string, unknown>[]>;
}

function importResultIntoRun(db: Database.Database, runId: number, result: RunnerResult): void {
	const run = result.run;
	const existingRun = db.prepare('SELECT database FROM benchmark_runs WHERE id = ?').get(runId) as { database: string } | undefined;
	const resolvedDatabase = run.database ?? existingRun?.database ?? '';

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
		db.transaction(() => {
			for (const s of steps) {
				insStep.run(
					runId, s.step_id, s.position, s.name, s.type, s.status,
					s.command ?? '', s.log ?? '', s.processed_script ?? '',
					s.pgbench_summary ? JSON.stringify(s.pgbench_summary) : '',
					s.pgbench_scripts ? JSON.stringify(s.pgbench_scripts) : '',
					s.sysbench_summary ? JSON.stringify(s.sysbench_summary) : '',
					s.started_at, s.finished_at
				);
			}
		})();
	}

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
			const stmt = db.prepare(`INSERT INTO ${snapTableName} (${insertCols.join(', ')}) VALUES (${placeholders})`);

			const insertMany = db.transaction((rowsToInsert: Record<string, unknown>[]) => {
				for (const row of rowsToInsert) {
					const params: Record<string, unknown> = { p0: runId };
					rowMetaCols.forEach((col, i) => {
						params[`p${i + 1}`] = normalizeSqliteValue(col === '_collected_at' ? (row[col] ?? new Date().toISOString()) : row[col]);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertRunningRun(db: Database.Database, overrides: Record<string, unknown> = {}): number {
	const result = db.prepare(`
		INSERT INTO benchmark_runs (status, database, exec_log_path)
		VALUES ('running', 'mybench', '/tmp/mybench-logs/run_test.log')
	`).run();
	const runId = result.lastInsertRowid as number;
	if (Object.keys(overrides).length) {
		for (const [col, val] of Object.entries(overrides)) {
			db.prepare(`UPDATE benchmark_runs SET ${col} = ? WHERE id = ?`).run(val, runId);
		}
	}
	return runId;
}

// Simulates rows inserted by the live-tail executor (step_start/step_done events)
function insertLiveTailStepRows(db: Database.Database, runId: number, steps: Array<{ step_id: number; name: string; type: string; output_file?: string }>) {
	const ins = db.prepare(`
		INSERT INTO run_step_results (run_id, step_id, position, name, type, status, output_file)
		VALUES (?, ?, ?, ?, ?, 'completed', ?)
	`);
	steps.forEach((s, i) => ins.run(runId, s.step_id, i, s.name, s.type, s.output_file ?? ''));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYSBENCH_RESULT: RunnerResult = {
	run: {
		status: 'completed',
		started_at: '2026-05-10T05:02:50Z',
		finished_at: '2026-05-10T05:06:22Z',
		bench_started_at: '2026-05-10T05:03:06Z',
		post_started_at: '2026-05-10T05:06:07Z',
		snapshot_interval_seconds: 10,
		pre_collect_secs: 0,
		post_collect_secs: 60,
		tps: 1133.28,
		latency_avg_ms: 1.76,
		transactions: 203998,
		profile_name: 'batch_1',
		params: [{ name: 'BATCH_SIZE', value: '1' }]
	},
	steps: [
		{ step_id: 146, position: 0, name: '1 — Init schema', type: 'sql', status: 'completed', started_at: '2026-05-10T05:02:50Z', finished_at: '2026-05-10T05:02:50Z' },
		{ step_id: 147, position: 1, name: '2 — Seed data', type: 'sql', status: 'completed', started_at: '2026-05-10T05:02:50Z', finished_at: '2026-05-10T05:02:51Z' },
		{
			step_id: 157, position: 7, name: '8 — Sysbench batch insert', type: 'sysbench', status: 'completed',
			sysbench_summary: { tps: 1133.28, latency_avg_ms: 1.76, transactions: 203998, errors: 0, elapsed_secs: 180 },
			started_at: '2026-05-10T05:03:06Z', finished_at: '2026-05-10T05:06:07Z'
		}
	],
	snapshots: {
		snap_pg_stat_user_tables: [
			{ _collected_at: '2026-05-10T05:02:52Z', _phase: 'pre', relname: 'orders', n_live_tup: '0', seq_scan: '0' },
			{ _collected_at: '2026-05-10T05:06:10Z', _phase: 'post', relname: 'orders', n_live_tup: '203998', seq_scan: '1' }
		],
		snap_pg_stat_statements: [
			{ _collected_at: '2026-05-10T05:06:10Z', _step_id: 153, queryid: '1234567890', calls: '9', total_exec_time: 45.2, query: 'INSERT INTO orders VALUES ($1)', toplevel: true }
		]
	}
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('importResultIntoRun', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
	});

	it('updates run status to completed', () => {
		const runId = insertRunningRun(db);
		importResultIntoRun(db, runId, SYSBENCH_RESULT);
		const row = db.prepare('SELECT status, tps, transactions, profile_name FROM benchmark_runs WHERE id = ?').get(runId) as {
			status: string; tps: number; transactions: number; profile_name: string;
		};
		expect(row.status).toBe('completed');
		expect(row.tps).toBeCloseTo(1133.28);
		expect(row.transactions).toBe(203998);
		expect(row.profile_name).toBe('batch_1');
	});

	it('stores run_params as JSON', () => {
		const runId = insertRunningRun(db);
		importResultIntoRun(db, runId, SYSBENCH_RESULT);
		const row = db.prepare('SELECT run_params FROM benchmark_runs WHERE id = ?').get(runId) as { run_params: string };
		expect(JSON.parse(row.run_params)).toEqual([{ name: 'BATCH_SIZE', value: '1' }]);
	});

	it('replaces live-tail step rows with result step rows', () => {
		const runId = insertRunningRun(db);
		// Simulate rows written by the live tail (with output_file populated)
		insertLiveTailStepRows(db, runId, [
			{ step_id: 146, name: '1 — Init schema', type: 'sql', output_file: '/tmp/mybench-logs/step_1.log' },
			{ step_id: 157, name: '8 — Sysbench batch insert', type: 'sysbench', output_file: '/tmp/mybench-logs/step_8.log' }
		]);
		const beforeCount = (db.prepare('SELECT COUNT(*) as n FROM run_step_results WHERE run_id = ?').get(runId) as { n: number }).n;
		expect(beforeCount).toBe(2);

		importResultIntoRun(db, runId, SYSBENCH_RESULT);

		const afterRows = db.prepare('SELECT step_id, type, status FROM run_step_results WHERE run_id = ? ORDER BY position').all(runId) as {
			step_id: number; type: string; status: string;
		}[];
		// Should now have 3 rows from result.steps (not 2 from live tail)
		expect(afterRows).toHaveLength(3);
		expect(afterRows.find(r => r.step_id === 157)?.type).toBe('sysbench');
		// output_file should be empty (import INSERT doesn't set it)
		const sysbenchRow = db.prepare('SELECT output_file FROM run_step_results WHERE run_id = ? AND step_id = 157').get(runId) as { output_file: string };
		expect(sysbenchRow.output_file).toBe('');
	});

	it('stores sysbench_summary_json for sysbench steps', () => {
		const runId = insertRunningRun(db);
		importResultIntoRun(db, runId, SYSBENCH_RESULT);
		const row = db.prepare('SELECT sysbench_summary_json FROM run_step_results WHERE run_id = ? AND step_id = 157').get(runId) as { sysbench_summary_json: string };
		const summary = JSON.parse(row.sysbench_summary_json);
		expect(summary.tps).toBeCloseTo(1133.28);
		expect(summary.transactions).toBe(203998);
	});

	it('inserts snap_pg_stat_user_tables rows with _phase', () => {
		const runId = insertRunningRun(db);
		importResultIntoRun(db, runId, SYSBENCH_RESULT);
		const rows = db.prepare('SELECT _phase, relname, n_live_tup FROM snap_pg_stat_user_tables WHERE _run_id = ? ORDER BY _phase').all(runId) as {
			_phase: string; relname: string; n_live_tup: string;
		}[];
		expect(rows).toHaveLength(2);
		expect(rows.find(r => r._phase === 'pre')?.n_live_tup).toBe('0');
		expect(rows.find(r => r._phase === 'post')?.n_live_tup).toBe('203998');
	});

	it('inserts snap_pg_stat_statements rows with _step_id and correct column types', () => {
		const runId = insertRunningRun(db);
		importResultIntoRun(db, runId, SYSBENCH_RESULT);
		const rows = db.prepare('SELECT _step_id, queryid, calls, total_exec_time, query, toplevel FROM snap_pg_stat_statements WHERE _run_id = ?').all(runId) as {
			_step_id: number; queryid: number; calls: number; total_exec_time: number; query: string; toplevel: number;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]._step_id).toBe(153);
		expect(rows[0].queryid).toBe(1234567890);
		expect(rows[0].calls).toBe(9);
		expect(rows[0].total_exec_time).toBeCloseTo(45.2);
		expect(rows[0].query).toContain('INSERT INTO orders');
		expect(rows[0].toplevel).toBe(1); // boolean true → 1
	});

	it('falls back to existing database value when result.run.database is absent', () => {
		const runId = insertRunningRun(db, { database: 'original_db' });
		const resultWithoutDb: RunnerResult = {
			run: { status: 'completed', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z' }
		};
		importResultIntoRun(db, runId, resultWithoutDb);
		const row = db.prepare('SELECT database FROM benchmark_runs WHERE id = ?').get(runId) as { database: string };
		expect(row.database).toBe('original_db');
	});

	it('handles result with no steps or snapshots without error', () => {
		const runId = insertRunningRun(db);
		expect(() => importResultIntoRun(db, runId, {
			run: { status: 'completed', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z' }
		})).not.toThrow();
		const row = db.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId) as { status: string };
		expect(row.status).toBe('completed');
	});

	it('is idempotent: importing the same result twice yields correct row counts', () => {
		const runId = insertRunningRun(db);
		importResultIntoRun(db, runId, SYSBENCH_RESULT);
		// Simulate a second import (e.g. recovery replaying the same result)
		importResultIntoRun(db, runId, SYSBENCH_RESULT);
		const stepCount = (db.prepare('SELECT COUNT(*) as n FROM run_step_results WHERE run_id = ?').get(runId) as { n: number }).n;
		const snapCount = (db.prepare('SELECT COUNT(*) as n FROM snap_pg_stat_user_tables WHERE _run_id = ?').get(runId) as { n: number }).n;
		expect(stepCount).toBe(3); // DELETE + INSERT each time — always 3
		expect(snapCount).toBe(4); // snapshots are NOT deleted on re-import — accumulate
	});

	it('multiple runs in same suite do not share snapshot rows', () => {
		const runId1 = insertRunningRun(db);
		const runId2 = insertRunningRun(db);
		importResultIntoRun(db, runId1, SYSBENCH_RESULT);
		importResultIntoRun(db, runId2, SYSBENCH_RESULT);
		const count1 = (db.prepare('SELECT COUNT(*) as n FROM snap_pg_stat_user_tables WHERE _run_id = ?').get(runId1) as { n: number }).n;
		const count2 = (db.prepare('SELECT COUNT(*) as n FROM snap_pg_stat_user_tables WHERE _run_id = ?').get(runId2) as { n: number }).n;
		expect(count1).toBe(2);
		expect(count2).toBe(2);
	});
});
