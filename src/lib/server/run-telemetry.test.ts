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
    CREATE TABLE snap_pg_stat_wal (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      wal_records INTEGER,
      wal_fpi INTEGER,
      wal_bytes REAL,
      wal_buffers_full INTEGER
    );
    CREATE TABLE snap_pg_stat_io (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      backend_type TEXT,
      object TEXT,
      context TEXT,
      reads INTEGER,
      read_bytes INTEGER,
      writes INTEGER,
      write_bytes INTEGER,
      extends INTEGER,
      extend_bytes INTEGER,
      hits INTEGER,
      evictions INTEGER,
      fsyncs INTEGER
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

	const insertWalRow = db.prepare(`
    INSERT INTO snap_pg_stat_wal (_run_id, _collected_at, _phase, wal_records, wal_fpi, wal_bytes, wal_buffers_full)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
	insertWalRow.run(1, '2026-03-30T05:57:59Z', 'bench', 100, 10, 1000, 2);
	insertWalRow.run(1, '2026-03-30T05:58:19Z', 'bench', 140, 18, 2200, 5);

	const insertIoRow = db.prepare(`
    INSERT INTO snap_pg_stat_io (_run_id, _collected_at, _phase, backend_type, object, context, reads, read_bytes, writes, write_bytes, extends, extend_bytes, hits, evictions, fsyncs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	insertIoRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'client backend', 'relation', 'normal', 10, 81920, 4, 32768, 1, 8192, 20, 2, 1);
	insertIoRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'client backend', 'relation', 'normal', 15, 122880, 7, 57344, 3, 24576, 25, 5, 2);
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
		expect(wal?.status).toBe('ok');
		expect(checkpointer?.status).toBe('unsupported');
	});

	it('reports PG18 WAL and IO metrics without legacy WAL timing columns', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const wal = telemetry.sections.find((section) => section.key === 'wal');
		const io = telemetry.sections.find((section) => section.key === 'io');

		expect(wal?.summary.map((card) => card.key)).toEqual([
			'wal_bytes',
			'wal_bytes_per_tx',
			'fpi_ratio',
			'wal_buffers_full'
		]);
		expect(wal?.tableRows).toEqual([
			expect.objectContaining({ metric: 'WAL bytes', value: 1200 }),
			expect.objectContaining({ metric: 'WAL records', value: 40 }),
			expect.objectContaining({ metric: 'Full page images', value: 8 }),
			expect.objectContaining({ metric: 'FPI ratio', value: 0.2 }),
			expect.objectContaining({ metric: 'WAL buffers full', value: 3 })
		]);

		expect(io?.summary.map((card) => [card.key, card.value])).toEqual([
			['reads', 5],
			['read_bytes', 40960],
			['writes', 3],
			['write_bytes', 24576],
			['extend_bytes', 16384],
			['evictions', 3],
			['fsyncs', 1]
		]);
		expect(io?.tableRows).toEqual([
			{
				group: 'client backend/relation/normal',
				reads: 5,
				read_bytes: 40960,
				writes: 3,
				write_bytes: 24576,
				extends: 2,
				extend_bytes: 16384,
				hits: 5,
				evictions: 3,
				fsyncs: 1
			}
		]);
	});
});
