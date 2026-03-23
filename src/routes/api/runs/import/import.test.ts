import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

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

	const runCols = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
	if (!runCols.includes('is_imported')) {
		db.exec(`ALTER TABLE benchmark_runs ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 0`);
	}

	const run = result.run;
	const insertResult = db.prepare(`
		INSERT INTO benchmark_runs (
			design_id, status, started_at, finished_at,
			bench_started_at, post_started_at,
			snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
			tps, latency_avg_ms, latency_stddev_ms, transactions,
			is_imported
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
	`).run(
		designId,
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

	const snapshots = result.snapshots;
	if (snapshots) {
		for (const [snapTableName, rows] of Object.entries(snapshots)) {
			if (!Array.isArray(rows) || rows.length === 0) continue;

			db.exec(`CREATE TABLE IF NOT EXISTS ${snapTableName} (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER,
				_collected_at TEXT,
				_phase TEXT
			)`);

			const existingCols = new Set(
				(db.prepare(`PRAGMA table_info(${snapTableName})`).all() as { name: string }[]).map(r => r.name)
			);

			const metaCols = new Set(['_collected_at', '_phase', '_is_baseline']);
			const firstRow = rows[0];
			const dataCols = Object.keys(firstRow).filter(k => !metaCols.has(k));

			for (const col of dataCols) {
				if (!existingCols.has(col)) {
					db.exec(`ALTER TABLE ${snapTableName} ADD COLUMN ${col} TEXT`);
				}
			}

			const insertCols = ['_run_id', '_collected_at', '_phase', ...dataCols];
			const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
			const stmt = db.prepare(
				`INSERT INTO ${snapTableName} (${insertCols.join(', ')}) VALUES (${placeholders})`
			);

			const insertMany = db.transaction((rowsToInsert: Record<string, unknown>[]) => {
				for (const row of rowsToInsert) {
					const params: Record<string, unknown> = {
						p0: runId,
						p1: row['_collected_at'] ?? new Date().toISOString(),
						p2: row['_phase'] ?? 'bench'
					};
					dataCols.forEach((col, i) => {
						params[`p${i + 3}`] = row[col] ?? null;
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
				status: string; tps: number; latency_avg_ms: number; transactions: number;
			};
			expect(run.status).toBe('completed');
			expect(run.tps).toBeCloseTo(279.5);
			expect(run.latency_avg_ms).toBeCloseTo(107.0);
			expect(run.transactions).toBe(33498);
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
});
