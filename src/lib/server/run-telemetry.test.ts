import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRunTelemetry } from './run-telemetry';

function createDb() {
	const db = new Database(':memory:');
	db.exec(`
    CREATE TABLE designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      database TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE benchmark_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL,
      database TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      bench_started_at TEXT,
      post_started_at TEXT
    );
    CREATE TABLE snap_pg_stat_database (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      datname TEXT,
      xact_commit INTEGER,
      xact_rollback INTEGER,
      blks_read INTEGER,
      blks_hit INTEGER,
      temp_bytes INTEGER,
      deadlocks INTEGER
    );
    CREATE TABLE snap_pg_stat_user_tables (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      schemaname TEXT,
      relname TEXT,
      seq_scan INTEGER,
      idx_scan INTEGER,
      n_tup_ins INTEGER,
      n_tup_upd INTEGER,
      n_tup_del INTEGER,
      n_tup_hot_upd INTEGER,
      n_dead_tup INTEGER
    );
  `);
	return db;
}

function seedRun(db: Database.Database) {
	db.prepare(`INSERT INTO designs (id, database) VALUES (1, 'changed_db')`).run();
	db.prepare(`
    INSERT INTO benchmark_runs (id, design_id, database, started_at, bench_started_at, post_started_at)
    VALUES (1, 1, 'benchmark', '2026-03-30T05:57:30Z', '2026-03-30T05:57:49Z', '2026-03-30T05:58:49Z')
  `).run();

	const insertDbRow = db.prepare(`
    INSERT INTO snap_pg_stat_database (_run_id, _collected_at, _phase, datname, xact_commit, xact_rollback, blks_read, blks_hit, temp_bytes, deadlocks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	insertDbRow.run(1, '2026-03-30T05:57:38Z', 'pre', 'benchmark', 100, 5, 10, 90, 0, 0);
	insertDbRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'benchmark', 120, 6, 20, 180, 500, 0);
	insertDbRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'benchmark', 140, 8, 30, 270, 1000, 1);
	insertDbRow.run(1, '2026-03-30T05:58:59Z', 'post', 'benchmark', 150, 8, 35, 300, 1200, 1);

	// These rows should be ignored because telemetry must use benchmark_runs.database.
	insertDbRow.run(1, '2026-03-30T05:57:38Z', 'pre', 'changed_db', 1000, 0, 100, 100, 0, 0);
	insertDbRow.run(1, '2026-03-30T05:58:59Z', 'post', 'changed_db', 3000, 0, 300, 100, 0, 0);

	const insertTableRow = db.prepare(`
    INSERT INTO snap_pg_stat_user_tables (_run_id, _collected_at, _phase, schemaname, relname, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd, n_dead_tup)
    VALUES (?, ?, ?, 'public', ?, ?, ?, ?, ?, ?, ?, ?)
  `);

	const tables = [
		['table_a', 0, 10, 40, 35, 25, 20, 15],
		['table_b', 1, 10, 35, 30, 25, 15, 12],
		['table_c', 2, 8, 30, 25, 25, 10, 9],
		['table_d', 1, 7, 25, 25, 20, 12, 8],
		['table_e', 0, 5, 20, 20, 20, 10, 7],
		['table_f', 0, 4, 20, 15, 15, 8, 6]
	] as const;

	for (const [name, seqBase, idxBase, insDelta, updDelta, delDelta, hotDelta, deadDelta] of tables) {
		insertTableRow.run(1, '2026-03-30T05:57:59Z', 'bench', name, seqBase, idxBase, 0, 0, 0, 0, 0);
		insertTableRow.run(1, '2026-03-30T05:58:19Z', 'bench', name, seqBase + 2, idxBase + 5, insDelta, updDelta, delDelta, hotDelta, deadDelta);
	}
}

describe('buildRunTelemetry', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createDb();
		seedRun(db);
	});

	it('filters pg_stat_database rows by benchmark_runs.database instead of the current design database', () => {
		const telemetry = buildRunTelemetry(db, 1);
		expect(telemetry.database).toBe('benchmark');
		const transactions = telemetry.heroCards.find((card) => card.key === 'transactions');
		expect(transactions?.value).toBe(53);
	});

	it('computes deltas and ratios from the selected phases', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const transactions = telemetry.heroCards.find((card) => card.key === 'transactions');
		const hitRatio = telemetry.heroCards.find((card) => card.key === 'buffer_hit_ratio');
		expect(transactions?.value).toBe(22);
		expect(hitRatio?.value).toBeCloseTo(0.9);
	});

	it('ranks the top five user tables and reports no_data/unsupported sections', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const userTables = telemetry.sections.find((section) => section.key === 'user_tables');
		expect(userTables?.status).toBe('ok');
		expect(userTables?.tableRows).toHaveLength(5);
		expect(userTables?.tableRows[0].table).toBe('table_a');
		expect(userTables?.tableRows.some((row) => row.table === 'table_f')).toBe(false);

		const wal = telemetry.sections.find((section) => section.key === 'wal');
		const checkpointer = telemetry.sections.find((section) => section.key === 'checkpointer');
		expect(wal?.status).toBe('no_data');
		expect(checkpointer?.status).toBe('unsupported');
	});
});
