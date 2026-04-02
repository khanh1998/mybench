import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getPgStatStatementsSqliteType } from '$lib/server/pg-stat-statements-schema';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

function createTestDb() {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(`
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE pg_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT 'localhost',
      port INTEGER NOT NULL DEFAULT 5432,
      username TEXT NOT NULL DEFAULT 'postgres',
      password TEXT NOT NULL DEFAULT '',
      ssl INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      server_id INTEGER REFERENCES pg_servers(id),
      database TEXT NOT NULL DEFAULT '',
      pre_collect_secs INTEGER NOT NULL DEFAULT 0,
      post_collect_secs INTEGER NOT NULL DEFAULT 60,
      snapshot_interval_seconds INTEGER NOT NULL DEFAULT 30
    );
    CREATE TABLE benchmark_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
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
      transactions INTEGER
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
      command TEXT NOT NULL DEFAULT '',
      processed_script TEXT NOT NULL DEFAULT '',
      pgbench_summary_json TEXT NOT NULL DEFAULT '',
      pgbench_scripts_json TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT
    );
  `);
	return db;
}

// ---------------------------------------------------------------------------
// Import logic extracted (mirrors +server.ts)
// ---------------------------------------------------------------------------

interface ImportResult {
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
		pgbench_summary?: {
			tps?: number;
			latency_avg_ms?: number;
			latency_stddev_ms?: number;
			transactions?: number;
			failed_transactions?: number;
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
		started_at: string;
		finished_at: string;
	}>;
	snapshots?: Record<string, Record<string, unknown>[]>;
}

function importRun(
	db: Database.Database,
	designId: number,
	result: ImportResult
): { run_id: number } | { error: string } {
	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId);
	if (!design) return { error: 'Design not found' };
	if (!result.run) return { error: 'Missing result.run' };

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

	const runCols = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
	if (!runCols.includes('is_imported')) {
		db.exec(`ALTER TABLE benchmark_runs ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 0`);
	}

	const run = result.run;
	const insertResult = db.prepare(`
		INSERT INTO benchmark_runs (
			design_id, database, status, started_at, finished_at,
			bench_started_at, post_started_at,
			snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
			tps, latency_avg_ms, latency_stddev_ms, transactions,
			is_imported
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
	`).run(
		designId,
		run.database ?? (design as { database: string }).database,
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
		run.transactions ?? null
	);

	const runId = insertResult.lastInsertRowid as number;

	if (result.steps?.length) {
		const insStep = db.prepare(`
			INSERT INTO run_step_results (
				run_id, step_id, position, name, type, status, command, stdout,
				processed_script, pgbench_summary_json, pgbench_scripts_json, started_at, finished_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		db.transaction(() => {
			for (const step of result.steps ?? []) {
				insStep.run(
					runId,
					step.step_id,
					step.position,
					step.name,
					step.type,
					step.status,
					step.command ?? '',
					step.log ?? '',
					step.processed_script ?? '',
					step.pgbench_summary ? JSON.stringify(step.pgbench_summary) : '',
					step.pgbench_scripts ? JSON.stringify(step.pgbench_scripts) : '',
					step.started_at,
					step.finished_at
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

	return { run_id: runId };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function seedDb(db: Database.Database) {
	db.prepare(`INSERT INTO decisions (id, name) VALUES (1, 'Test Decision')`).run();
	db.prepare(`INSERT INTO designs (id, decision_id, name, database) VALUES (1, 1, 'Design A', 'mydb')`).run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VALID_RESULT: ImportResult = {
	run: {
		status: 'completed',
		started_at: '2025-01-01T00:00:00Z',
		finished_at: '2025-01-01T00:01:00Z',
		bench_started_at: '2025-01-01T00:00:05Z',
		snapshot_interval_seconds: 10,
		pre_collect_secs: 30,
		post_collect_secs: 60,
		tps: 279.5,
		latency_avg_ms: 107.0,
		latency_stddev_ms: 136.4,
		transactions: 33498
	},
	snapshots: {
		snap_pg_stat_database: [
			{
				_collected_at: '2025-01-01T00:00:10Z',
				_phase: 'bench',
				datname: 'benchmark',
				xact_commit: '12345'
			},
			{
				_collected_at: '2025-01-01T00:00:20Z',
				_phase: 'bench',
				datname: 'benchmark',
				xact_commit: '13000'
			}
		]
	}
};

describe('Import endpoint logic', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
		seedDb(db);
	});

	it('inserts a benchmark_runs row and returns run_id', () => {
		const result = importRun(db, 1, VALID_RESULT);
		expect('run_id' in result).toBe(true);
		if ('run_id' in result) {
			expect(typeof result.run_id).toBe('number');
			expect(result.run_id).toBeGreaterThan(0);
		}
	});

	it('sets is_imported = 1 on the inserted run', () => {
		const result = importRun(db, 1, VALID_RESULT);
		expect('run_id' in result).toBe(true);
		if ('run_id' in result) {
			const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(result.run_id) as { is_imported: number };
			expect(run.is_imported).toBe(1);
		}
	});

	it('populates run fields from result.run', () => {
		const result = importRun(db, 1, VALID_RESULT);
		if ('run_id' in result) {
			const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(result.run_id) as {
				status: string; tps: number; latency_avg_ms: number; transactions: number; database: string;
			};
			expect(run.status).toBe('completed');
			expect(run.tps).toBeCloseTo(279.5);
			expect(run.latency_avg_ms).toBeCloseTo(107.0);
			expect(run.transactions).toBe(33498);
			expect(run.database).toBe('mydb');
		}
	});

	it('inserts snapshot rows into the correct snap table with _run_id set', () => {
		const result = importRun(db, 1, VALID_RESULT);
		expect('run_id' in result).toBe(true);
		if ('run_id' in result) {
			const rows = db.prepare('SELECT * FROM snap_pg_stat_database WHERE _run_id = ?').all(result.run_id) as {
				_run_id: number; _phase: string; datname: string; xact_commit: string;
			}[];
			expect(rows).toHaveLength(2);
			expect(rows[0]._run_id).toBe(result.run_id);
			expect(rows[0]._phase).toBe('bench');
			expect(rows[0].datname).toBe('benchmark');
			expect(rows[0].xact_commit).toBe('12345');
		}
	});

	it('returns 400-equivalent error when result.run is missing', () => {
		const result = importRun(db, 1, {} as ImportResult);
		expect('error' in result).toBe(true);
		if ('error' in result) {
			expect(result.error).toContain('Missing result.run');
		}
	});

	it('returns error when design_id is not found', () => {
		const result = importRun(db, 9999, VALID_RESULT);
		expect('error' in result).toBe(true);
		if ('error' in result) {
			expect(result.error).toContain('Design not found');
		}
	});

	it('succeeds with unknown snap table name by creating the table dynamically', () => {
		const resultWithUnknownTable: ImportResult = {
			run: { status: 'completed', started_at: '2025-01-01T00:00:00Z', finished_at: '2025-01-01T00:01:00Z' },
			snapshots: {
				snap_custom_metrics: [
					{ _collected_at: '2025-01-01T00:00:10Z', _phase: 'bench', metric_a: '42', metric_b: 'hello' }
				]
			}
		};

		const result = importRun(db, 1, resultWithUnknownTable);
		expect('run_id' in result).toBe(true);

		// Table should have been created
		const rows = db.prepare(`SELECT * FROM snap_custom_metrics`).all() as { metric_a: string; metric_b: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].metric_a).toBe('42');
		expect(rows[0].metric_b).toBe('hello');
	});

	it('imports snap_pg_stat_statements rows with _step_id metadata', () => {
		db.exec(`
			CREATE TABLE snap_pg_stat_statements (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER,
				_step_id INTEGER,
				_collected_at TEXT NOT NULL
			)
		`);

		const resultWithStatements: ImportResult = {
			run: { status: 'completed', started_at: '2025-01-01T00:00:00Z', finished_at: '2025-01-01T00:01:00Z' },
			snapshots: {
				snap_pg_stat_statements: [
					{
						_collected_at: '2025-01-01T00:00:30Z',
						_step_id: 37,
						queryid: '123',
						calls: '9',
						total_exec_time: 4.5,
						query: 'select 1',
						toplevel: true
					}
				]
			}
		};

		const result = importRun(db, 1, resultWithStatements);
		expect('run_id' in result).toBe(true);
		if ('run_id' in result) {
			const rows = db.prepare('SELECT _run_id, _step_id, queryid, calls, total_exec_time, query, toplevel FROM snap_pg_stat_statements WHERE _run_id = ?').all(result.run_id) as {
				_run_id: number; _step_id: number; queryid: number; calls: number; total_exec_time: number; query: string; toplevel: number;
			}[];
			expect(rows).toHaveLength(1);
			expect(rows[0]._run_id).toBe(result.run_id);
			expect(rows[0]._step_id).toBe(37);
			expect(rows[0].queryid).toBe(123);
			expect(rows[0].calls).toBe(9);
			expect(rows[0].total_exec_time).toBe(4.5);
			expect(rows[0].query).toBe('select 1');
			expect(rows[0].toplevel).toBe(1);

			const cols = db.prepare(`PRAGMA table_info(snap_pg_stat_statements)`).all() as { name: string; type: string }[];
			expect(cols.find((col) => col.name === 'queryid')?.type).toBe('INTEGER');
			expect(cols.find((col) => col.name === 'total_exec_time')?.type).toBe('REAL');
			expect(cols.find((col) => col.name === 'query')?.type).toBe('TEXT');
		}
	});

	it('imports snap_pg_stat_checkpointer rows and preserves phase metadata', () => {
		const resultWithCheckpointer: ImportResult = {
			run: { status: 'completed', started_at: '2025-01-01T00:00:00Z', finished_at: '2025-01-01T00:01:00Z' },
			snapshots: {
				snap_pg_stat_checkpointer: [
					{
						_collected_at: '2025-01-01T00:00:30Z',
						_phase: 'post',
						num_timed: 2,
						num_requested: 1,
						buffers_written: 512,
						write_time: 7.25
					}
				]
			}
		};

		const result = importRun(db, 1, resultWithCheckpointer);
		expect('run_id' in result).toBe(true);
		if ('run_id' in result) {
			const rows = db.prepare(`
				SELECT _run_id, _collected_at, _phase, num_timed, num_requested, buffers_written, write_time
				FROM snap_pg_stat_checkpointer
				WHERE _run_id = ?
			`).all(result.run_id) as {
				_run_id: number;
				_collected_at: string;
				_phase: string;
				num_timed: string;
				num_requested: string;
				buffers_written: string;
				write_time: string;
			}[];

			expect(rows).toHaveLength(1);
			expect(rows[0]._run_id).toBe(result.run_id);
			expect(rows[0]._collected_at).toBe('2025-01-01T00:00:30Z');
			expect(rows[0]._phase).toBe('post');
			expect(Number(rows[0].num_timed)).toBe(2);
			expect(Number(rows[0].num_requested)).toBe(1);
			expect(Number(rows[0].buffers_written)).toBe(512);
			expect(Number(rows[0].write_time)).toBeCloseTo(7.25);
		}
	});

	it('persists structured pgbench step details for imported runs', () => {
		const importWithSteps: ImportResult = {
			run: { status: 'completed', started_at: '2025-01-01T00:00:00Z', finished_at: '2025-01-01T00:01:00Z' },
			steps: [
				{
					step_id: 47,
					position: 3,
					name: 'Mixed workload',
					type: 'pgbench',
					status: 'completed',
					command: 'pgbench ...',
					log: 'pgbench output',
					processed_script: '-- [main @10]\nSELECT 1;',
					pgbench_summary: {
						tps: 64.854015,
						latency_avg_ms: 898.249,
						latency_stddev_ms: 7394.088,
						transactions: 19646,
						failed_transactions: 0
					},
					pgbench_scripts: [
						{
							position: 0,
							name: 'main',
							weight: 10,
							script: 'SELECT 1;',
							tps: 6.579154,
							latency_avg_ms: 85.066,
							latency_stddev_ms: 278.99,
							transactions: 1993,
							failed_transactions: 0
						}
					],
					started_at: '2025-01-01T00:00:10Z',
					finished_at: '2025-01-01T00:01:00Z'
				}
			]
		};

		const result = importRun(db, 1, importWithSteps);
		expect('run_id' in result).toBe(true);
		if ('run_id' in result) {
			const row = db.prepare(`
				SELECT command, stdout, processed_script, pgbench_summary_json, pgbench_scripts_json
				FROM run_step_results
				WHERE run_id = ? AND step_id = 47
			`).get(result.run_id) as {
				command: string;
				stdout: string;
				processed_script: string;
				pgbench_summary_json: string;
				pgbench_scripts_json: string;
			};

			expect(row.command).toBe('pgbench ...');
			expect(row.stdout).toBe('pgbench output');
			expect(row.processed_script).toContain('[main @10]');
			expect(JSON.parse(row.pgbench_summary_json)).toMatchObject({
				tps: 64.854015,
				transactions: 19646,
				failed_transactions: 0
			});
			expect(JSON.parse(row.pgbench_scripts_json)).toMatchObject([
				expect.objectContaining({
					name: 'main',
					weight: 10,
					tps: 6.579154,
					transactions: 1993
				})
			]);
		}
	});
});
