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
      tup_returned INTEGER,
      tup_fetched INTEGER,
      tup_inserted INTEGER,
      tup_updated INTEGER,
      tup_deleted INTEGER,
      blk_read_time REAL,
      blk_write_time REAL,
      temp_files INTEGER,
      temp_bytes INTEGER,
      sessions INTEGER,
      sessions_abandoned INTEGER,
      sessions_fatal INTEGER,
      sessions_killed INTEGER,
      session_time REAL,
      active_time REAL,
      idle_in_transaction_time REAL,
      parallel_workers_to_launch INTEGER,
      parallel_workers_launched INTEGER,
      deadlocks INTEGER
    );
    CREATE TABLE snap_pg_stat_database_conflicts (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      datname TEXT,
      confl_tablespace INTEGER,
      confl_lock INTEGER,
      confl_snapshot INTEGER,
      confl_bufferpin INTEGER,
      confl_deadlock INTEGER,
      confl_active_logicalslot INTEGER
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
    CREATE TABLE snap_pg_stat_bgwriter (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      buffers_clean INTEGER,
      maxwritten_clean INTEGER,
      buffers_alloc INTEGER,
      stats_reset TEXT
    );
    CREATE TABLE snap_pg_stat_checkpointer (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      num_timed INTEGER,
      num_requested INTEGER,
      restartpoints_timed INTEGER,
      restartpoints_req INTEGER,
      restartpoints_done INTEGER,
      write_time REAL,
      sync_time REAL,
      buffers_written INTEGER,
      stats_reset TEXT
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
      read_time REAL,
      writes INTEGER,
      write_bytes INTEGER,
      write_time REAL,
      writebacks INTEGER,
      writeback_time REAL,
      extends INTEGER,
      extend_bytes INTEGER,
      extend_time REAL,
      hits INTEGER,
      evictions INTEGER,
      reuses INTEGER,
      fsyncs INTEGER,
      fsync_time REAL
    );
    CREATE TABLE snap_pg_statio_user_tables (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      schemaname TEXT,
      relname TEXT,
      heap_blks_read INTEGER,
      heap_blks_hit INTEGER,
      toast_blks_read INTEGER
    );
    CREATE TABLE snap_pg_statio_user_sequences (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL,
      schemaname TEXT,
      relname TEXT,
      blks_read INTEGER,
      blks_hit INTEGER
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
    INSERT INTO snap_pg_stat_database (
      _run_id, _collected_at, _phase, datname, xact_commit, xact_rollback,
      blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
      blk_read_time, blk_write_time, temp_files, temp_bytes,
      sessions, sessions_abandoned, sessions_fatal, sessions_killed,
      session_time, active_time, idle_in_transaction_time,
      parallel_workers_to_launch, parallel_workers_launched, deadlocks
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	insertDbRow.run(1, '2026-03-30T05:57:38Z', 'pre', 'benchmark', 100, 5, 10, 90, 900, 80, 0, 0, 0, 100, 10, 0, 0, 10, 1, 0, 0, 0, 0, 0, 0, 0, 0);
	insertDbRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'benchmark', 120, 6, 20, 180, 1000, 100, 10, 5, 0, 160, 22, 1, 500, 12, 1, 0, 0, 1000, 800, 100, 2, 1, 0);
	insertDbRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'benchmark', 140, 8, 30, 270, 1500, 140, 20, 15, 5, 240, 42, 3, 1000, 16, 2, 1, 0, 3000, 2200, 300, 5, 4, 1);
	insertDbRow.run(1, '2026-03-30T05:58:59Z', 'post', 'benchmark', 150, 8, 35, 300, 1700, 150, 25, 20, 8, 260, 47, 4, 1200, 18, 2, 1, 1, 3600, 2400, 360, 6, 5, 1);

	// These rows should be ignored because telemetry must use benchmark_runs.database.
	insertDbRow.run(1, '2026-03-30T05:57:38Z', 'pre', 'changed_db', 1000, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
	insertDbRow.run(1, '2026-03-30T05:58:59Z', 'post', 'changed_db', 3000, 0, 300, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

	const insertConflictRow = db.prepare(`
    INSERT INTO snap_pg_stat_database_conflicts (
      _run_id, _collected_at, _phase, datname, confl_tablespace, confl_lock,
      confl_snapshot, confl_bufferpin, confl_deadlock, confl_active_logicalslot
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	insertConflictRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'benchmark', 0, 2, 1, 0, 0, 0);
	insertConflictRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'benchmark', 1, 3, 3, 2, 1, 1);

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

	const insertBgwriterRow = db.prepare(`
    INSERT INTO snap_pg_stat_bgwriter (_run_id, _collected_at, _phase, buffers_clean, maxwritten_clean, buffers_alloc, stats_reset)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
	insertBgwriterRow.run(1, '2026-03-30T05:57:59Z', 'bench', 100, 3, 200, '2026-03-30T05:00:00Z');
	insertBgwriterRow.run(1, '2026-03-30T05:58:19Z', 'bench', 160, 5, 260, '2026-03-30T05:00:00Z');

	const insertCheckpointerRow = db.prepare(`
    INSERT INTO snap_pg_stat_checkpointer (
      _run_id, _collected_at, _phase, num_timed, num_requested, restartpoints_timed,
      restartpoints_req, restartpoints_done, write_time, sync_time, buffers_written, stats_reset
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	insertCheckpointerRow.run(1, '2026-03-30T05:57:59Z', 'bench', 2, 1, 0, 0, 0, 100, 20, 400, '2026-03-30T05:00:00Z');
	insertCheckpointerRow.run(1, '2026-03-30T05:58:19Z', 'bench', 5, 3, 1, 1, 1, 180, 35, 520, '2026-03-30T05:00:00Z');

	const insertIoRow = db.prepare(`
    INSERT INTO snap_pg_stat_io (
      _run_id, _collected_at, _phase, backend_type, object, context,
      reads, read_bytes, read_time, writes, write_bytes, write_time,
      writebacks, writeback_time, extends, extend_bytes, extend_time,
      hits, evictions, reuses, fsyncs, fsync_time
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	insertIoRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'client backend', 'relation', 'normal', 10, 81920, 20, 4, 32768, 12, 1, 4, 1, 8192, 3, 20, 2, 1, 1, 5);
	insertIoRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'client backend', 'relation', 'normal', 15, 122880, 40, 7, 57344, 24, 3, 14, 3, 24576, 9, 25, 5, 2, 2, 11);

	const insertStatioUserTableRow = db.prepare(`
    INSERT INTO snap_pg_statio_user_tables (_run_id, _collected_at, _phase, schemaname, relname, heap_blks_read, heap_blks_hit, toast_blks_read)
    VALUES (?, ?, ?, 'public', ?, ?, ?, ?)
  `);
	insertStatioUserTableRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'table_a', 0, 100, 0);
	insertStatioUserTableRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'table_a', 0, 260, 0);
	insertStatioUserTableRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'table_b', 0, 50, 0);
	insertStatioUserTableRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'table_b', 0, 140, 0);

	const insertStatioUserSequenceRow = db.prepare(`
    INSERT INTO snap_pg_statio_user_sequences (_run_id, _collected_at, _phase, schemaname, relname, blks_read, blks_hit)
    VALUES (?, ?, ?, 'public', ?, ?, ?)
  `);
	insertStatioUserSequenceRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'seq_a', 0, 20);
	insertStatioUserSequenceRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'seq_a', 4, 80);
	insertStatioUserSequenceRow.run(1, '2026-03-30T05:57:59Z', 'bench', 'seq_b', 1, 10);
	insertStatioUserSequenceRow.run(1, '2026-03-30T05:58:19Z', 'bench', 'seq_b', 3, 35);
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

	it('exposes block I/O time as rate and raw delta views', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const database = telemetry.sections.find((section) => section.key === 'database');
		const blockIoTime = database?.chartMetrics?.find((metric) => metric.key === 'block_io_time');

		expect(blockIoTime?.series.map((series) => series.label)).toEqual([
			'block read time/s',
			'block write time/s'
		]);
		expect(blockIoTime?.series.find((series) => series.label === 'block read time/s')?.points).toEqual([
			{ t: 49000, v: 4 }
		]);
		expect(blockIoTime?.rawSeries?.map((series) => series.label)).toEqual([
			'block read time',
			'block write time'
		]);
		expect(blockIoTime?.rawSeries?.find((series) => series.label === 'block read time')?.points).toEqual([
			{ t: 29000, v: 0 },
			{ t: 49000, v: 80 }
		]);
	});

	it('exposes temp usage as rate and raw delta views and includes temp files', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const database = telemetry.sections.find((section) => section.key === 'database');
		const tempUsage = database?.chartMetrics?.find((metric) => metric.key === 'temp_usage');
		const tempFiles = database?.chartMetrics?.find((metric) => metric.key === 'temp_files');

		expect(tempUsage).toEqual(expect.objectContaining({
			label: 'Temp Usage',
			kind: 'bytes'
		}));
		expect(tempUsage?.series.find((series) => series.label === 'temp bytes/s')?.points).toEqual([
			{ t: 49000, v: 25 }
		]);
		expect(tempUsage?.rawSeries?.find((series) => series.label === 'temp bytes')?.points).toEqual([
			{ t: 29000, v: 0 },
			{ t: 49000, v: 500 }
		]);
		expect(tempFiles).toEqual(expect.objectContaining({
			label: 'Temp Files',
			kind: 'count'
		}));
		expect(tempFiles?.series.find((series) => series.label === 'temp files/s')?.points).toEqual([
			{ t: 49000, v: 0.1 }
		]);
		expect(tempFiles?.rawSeries?.find((series) => series.label === 'temp files')?.points).toEqual([
			{ t: 29000, v: 0 },
			{ t: 49000, v: 2 }
		]);
		expect(database?.tableRows.find((row) => row.metric === 'Temp files')?.value).toBe(2);
	});

	it('exposes session behavior and parallel worker metrics as rate and raw delta views', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const database = telemetry.sections.find((section) => section.key === 'database');
		const sessionTime = database?.chartMetrics?.find((metric) => metric.key === 'session_time');
		const sessions = database?.chartMetrics?.find((metric) => metric.key === 'sessions');
		const parallelWorkers = database?.chartMetrics?.find((metric) => metric.key === 'parallel_workers');

		expect(sessionTime?.series.map((series) => series.label)).toEqual([
			'session time/s',
			'active time/s',
			'idle in transaction time/s'
		]);
		expect(sessionTime?.series.find((series) => series.label === 'active time/s')?.points).toEqual([
			{ t: 49000, v: 70 }
		]);
		expect(sessionTime?.rawSeries?.find((series) => series.label === 'idle in transaction time')?.points).toEqual([
			{ t: 29000, v: 0 },
			{ t: 49000, v: 200 }
		]);
		expect(sessions).toEqual(expect.objectContaining({
			label: 'Sessions',
			group: 'Session Behavior',
			category: 'raw'
		}));
		expect(sessions?.series.map((series) => series.label)).toEqual([
			'sessions/s',
			'abandoned/s',
			'fatal/s',
			'killed/s'
		]);
		expect(sessions?.series.find((series) => series.label === 'sessions/s')?.points).toEqual([
			{ t: 49000, v: 0.2 }
		]);
		expect(sessions?.rawSeries?.find((series) => series.label === 'sessions fatal')?.points).toEqual([
			{ t: 29000, v: 0 },
			{ t: 49000, v: 1 }
		]);
		expect(sessions?.rawSeries?.find((series) => series.label === 'sessions')?.description).toContain('Total sessions established');
		expect(parallelWorkers?.series.map((series) => series.label)).toEqual([
			'workers to launch/s',
			'workers launched/s'
		]);
		expect(parallelWorkers?.rawSeries?.find((series) => series.label === 'workers launched')?.points).toEqual([
			{ t: 29000, v: 0 },
			{ t: 49000, v: 3 }
		]);
		expect(database?.summary).toEqual([]);
		expect(database?.tableRows.find((row) => row.metric === 'Session time (ms)')?.value).toBe(2000);
		expect(database?.tableRows.find((row) => row.metric === 'Sessions')?.value).toBe(4);
		expect(database?.tableRows.find((row) => row.metric === 'Sessions fatal')?.value).toBe(1);
		expect(database?.tableRows.find((row) => row.metric === 'Sessions abandoned')?.value).toBe(1);
		expect(database?.tableRows.find((row) => row.metric === 'Parallel workers launched')?.value).toBe(3);
		expect(database?.tableRows.find((row) => row.metric === 'Parallel workers to launch')?.value).toBe(3);
	});

	it('groups database metrics by root-cause area and exposes derived diagnostics', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const database = telemetry.sections.find((section) => section.key === 'database');
		const groupsByMetric = new Map(database?.chartMetrics?.map((metric) => [metric.key, metric.group]));

		expect(groupsByMetric.get('transactions')).toBe('Workload Shape');
		expect(groupsByMetric.get('io_per_tx')).toBe('I/O Pressure');
		expect(groupsByMetric.get('temp_bytes_per_tx')).toBe('Spills');
		expect(groupsByMetric.get('session_time_per_tx')).toBe('Session Behavior');
		expect(groupsByMetric.get('parallel_launch_success')).toBe('Parallelism');
		expect(groupsByMetric.get('deadlocks_per_tx')).toBe('Errors');

		expect(database?.chartMetrics?.find((metric) => metric.key === 'cache_miss_rate')?.series[0]?.points).toEqual([
			{ t: 49000, v: 0.1 }
		]);
		expect(database?.chartMetrics?.find((metric) => metric.key === 'io_per_tx')?.series.find((series) => series.label === 'disk reads / tx')?.points[0]?.v).toBeCloseTo(10 / 22);
		expect(database?.chartMetrics?.find((metric) => metric.key === 'avg_temp_file_size')?.series[0]?.points).toEqual([
			{ t: 49000, v: 250 }
		]);
		expect(database?.chartMetrics?.find((metric) => metric.key === 'parallel_launch_success')?.series[0]?.points).toEqual([
			{ t: 49000, v: 1 }
		]);
		expect(database?.chartMetrics?.find((metric) => metric.key === 'deadlocks_per_tx')?.series[0]?.points[0]?.v).toBeCloseTo(1 / 22 * 1_000_000);
		expect(database?.chartMetrics?.find((metric) => metric.key === 'cache_miss_rate')?.series[0]?.description).toContain('cache pressure');
		expect(database?.chartMetrics?.find((metric) => metric.key === 'cache_miss_rate')?.series[0]?.description).toContain('Uses: blks_read / (blks_hit + blks_read)');
		expect(database?.chartMetrics?.find((metric) => metric.key === 'temp_usage')?.series[0]?.description).toContain('per second');
		expect(database?.chartMetrics?.find((metric) => metric.key === 'temp_usage')?.rawSeries?.[0]?.description).toContain('Cumulative');
		expect(database?.tableRows.find((row) => row.metric === 'Temp bytes / tx')?.value).toBeCloseTo(500 / 22);
		expect(database?.tableRows.find((row) => row.metric === 'I/O time / active time')?.value).toBeCloseTo(100 / 1400);
	});

	it('adds explainer text to hero and summary cards', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const heroTransactions = telemetry.heroCards.find((card) => card.key === 'transactions');
		const walPerTx = telemetry.sections
			.find((section) => section.key === 'wal')
			?.summary.find((card) => card.key === 'wal_bytes_per_tx');

		expect(heroTransactions?.infoText).toContain('Commits plus rollbacks');
		expect(walPerTx?.infoText).toContain('Average WAL volume per transaction');
	});

	it('ranks the top five user tables and reports populated checkpointer telemetry', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const userTables = telemetry.sections.find((section) => section.key === 'user_tables');
		expect(userTables?.status).toBe('ok');
		expect(userTables?.tableRows).toHaveLength(5);
		expect(userTables?.tableRows[0].table).toBe('table_a');
		expect(userTables?.tableRows.some((row) => row.table === 'table_f')).toBe(false);

		const wal = telemetry.sections.find((section) => section.key === 'wal');
		const checkpointer = telemetry.sections.find((section) => section.key === 'checkpointer');
		expect(wal?.status).toBe('ok');
		expect(checkpointer?.status).toBe('ok');
		expect(checkpointer?.summary.map((card) => [card.key, card.value])).toEqual([
			['num_requested', 2],
			['num_timed', 3],
			['checkpoint_pressure', 0.4],
			['avg_checkpoint_write_ms', 16],
			['write_time', 80],
			['sync_time', 15]
		]);
	});

	it('reports PG18 WAL and IO metrics without legacy WAL timing columns', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const wal = telemetry.sections.find((section) => section.key === 'wal');
		const database = telemetry.sections.find((section) => section.key === 'database');
		const io = telemetry.sections.find((section) => section.key === 'io');

		expect(database?.chartSeries.map((series) => series.label)).toEqual([
			'total/s',
			'commits/s',
			'rollbacks/s'
		]);
		expect(telemetry.sections.some((section) => section.key === 'database_conflicts')).toBe(false);
		expect(wal?.chartSeries.map((series) => series.label)).toEqual([
			'wal bytes/s'
		]);
		expect(wal?.summary.map((card) => card.key)).toEqual([
			'wal_bytes',
			'wal_bytes_per_sec',
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
		expect(database?.tableSnapshots).toHaveLength(2);
		expect(database?.tableSnapshots?.[0]?.rows.find((row) => row.metric === 'Transactions')?.value).toBe(0);
		expect(database?.tableSnapshots?.[1]?.rows.find((row) => row.metric === 'Transactions')?.value).toBe(22);
		expect(wal?.tableSnapshots?.[0]?.rows.find((row) => row.metric === 'WAL bytes')?.value).toBe(0);
		expect(wal?.tableSnapshots?.[1]?.rows.find((row) => row.metric === 'WAL bytes')?.value).toBe(1200);

		expect(io?.summary).toEqual([]);
		expect(io?.chartMetrics?.map((metric) => metric.key)).toEqual(expect.arrayContaining([
			'read_bytes',
			'reads',
			'write_bytes',
			'writes',
			'extend_bytes',
			'extends',
			'hits',
			'evictions',
			'fsyncs',
			'read_time',
			'write_time',
			'writebacks',
			'reuses',
			'avg_read_time_ms',
			'avg_write_time_ms',
			'read_miss_ratio',
			'cache_hit_rate',
			'evictions_per_write',
			'fsyncs_per_write',
			'write_byte_share',
			'reuse_ratio',
			'io_time_mix'
		]));
		expect(io?.chartMetrics?.find((metric) => metric.key === 'read_bytes')?.group).toBe('Data Volume');
		expect(io?.chartMetrics?.find((metric) => metric.key === 'avg_read_time_ms')?.group).toBe('Latency');
		expect(io?.chartMetrics?.find((metric) => metric.key === 'read_miss_ratio')?.group).toBe('Buffer Pressure');
		expect(io?.chartMetrics?.find((metric) => metric.key === 'fsyncs_per_write')?.group).toBe('Writeback & Sync');
		expect(io?.chartMetrics?.find((metric) => metric.key === 'write_byte_share')?.group).toBe('I/O Mix');
		expect(io?.chartMetrics?.find((metric) => metric.key === 'read_bytes')?.description).toContain('Source: pg_stat_io.read_bytes');
		expect(io?.chartMetrics?.find((metric) => metric.key === 'avg_read_time_ms')?.description).toContain('Uses: read_time / reads');
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
		expect(io?.tableSnapshots).toHaveLength(2);
		expect(io?.tableSnapshots?.[0]?.rows[0]?.read_bytes).toBe(0);
		expect(io?.tableSnapshots?.[1]?.rows[0]?.read_bytes).toBe(40960);
	});

	it('uses the checkpointer section for requested checkpoint hero cards and keeps bgwriter schema-specific metrics', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const requestedCheckpoints = telemetry.heroCards.find((card) => card.key === 'requested_checkpoints');
		const bgwriter = telemetry.sections.find((section) => section.key === 'bgwriter');

		expect(requestedCheckpoints?.value).toBe(2);
		expect(bgwriter?.summary.map((card) => [card.key, card.value])).toEqual([
			['buffers_clean', 60],
			['maxwritten_clean', 2],
			['buffers_alloc', 60],
			['stats_reset', '2026-03-30T05:00:00Z']
		]);
		expect(bgwriter?.tableRows).toEqual([
			expect.objectContaining({ metric: 'Buffers clean', value: 60 }),
			expect.objectContaining({ metric: 'Maxwritten clean', value: 2 }),
			expect.objectContaining({ metric: 'Buffers alloc', value: 60 }),
			expect.objectContaining({ metric: 'Stats reset', value: '2026-03-30T05:00:00Z' })
		]);
	});

	it('surfaces cached heap activity in statio user tables even when heap reads stay at zero', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const statioTables = telemetry.sections.find((section) => section.key === 'statio_user_tables');
		const userTables = telemetry.sections.find((section) => section.key === 'user_tables');

		expect(statioTables?.summary.map((card) => [card.key, card.value])).toEqual([
			['heap_activity', 250],
			['heap_hits', 250],
			['heap_reads', 0],
			['heap_hit_ratio', 1],
			['toast_reads', 0]
		]);
		expect(statioTables?.chartTitle).toBe('Top tables by heap activity over time');
		expect(statioTables?.tableRows).toEqual([
			{
				table: 'table_a',
				heap_activity: 160,
				heap_hits: 160,
				heap_reads: 0,
				heap_hit_ratio: 1,
				toast_reads: 0
			},
			{
				table: 'table_b',
				heap_activity: 90,
				heap_hits: 90,
				heap_reads: 0,
				heap_hit_ratio: 1,
				toast_reads: 0
			}
		]);
		expect(userTables?.chartMetrics?.map((metric) => metric.key)).toEqual([
			'writes',
			'dead_tuple_growth',
			'seq_scan_ratio',
			'hot_update_ratio',
			'index_scan_ratio'
		]);
	});

	it('adds pg_statio_user_sequences telemetry with sequence block activity and hit ratio', () => {
		const telemetry = buildRunTelemetry(db, 1, ['bench']);
		const statioSequences = telemetry.sections.find((section) => section.key === 'statio_user_sequences');

		expect(statioSequences?.summary.map((card) => [card.key, card.value])).toEqual([
			['sequence_activity', 91],
			['sequence_hits', 85],
			['sequence_reads', 6],
			['sequence_hit_ratio', 0.931712962962963]
		]);
		expect(statioSequences?.chartMetrics?.map((metric) => metric.key)).toEqual([
			'sequence_activity',
			'sequence_hits',
			'sequence_reads',
			'sequence_hit_ratio'
		]);
		expect(statioSequences?.tableRows).toEqual([
			{
				sequence: 'seq_a',
				sequence_activity: 64,
				sequence_hits: 60,
				sequence_reads: 4,
				sequence_hit_ratio: 0.9375
			},
			{
				sequence: 'seq_b',
				sequence_activity: 27,
				sequence_hits: 25,
				sequence_reads: 2,
				sequence_hit_ratio: 0.9259259259259259
			}
		]);
	});

	it('exposes expanded per-process host metrics', () => {
		db.exec(`
			CREATE TABLE host_snap_proc_pid_stat (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER NOT NULL,
				_collected_at TEXT NOT NULL,
				pid INTEGER,
				comm TEXT,
				state TEXT,
				cmdline TEXT,
				minflt INTEGER,
				majflt INTEGER,
				utime INTEGER,
				stime INTEGER,
				num_threads INTEGER
			);
			CREATE TABLE host_snap_proc_pid_status (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER NOT NULL,
				_collected_at TEXT NOT NULL,
				pid INTEGER,
				name TEXT,
				state TEXT,
				fd_size INTEGER,
				threads INTEGER,
				vm_peak_kb INTEGER,
				vm_size_kb INTEGER,
				vm_rss_kb INTEGER,
				rss_anon_kb INTEGER,
				rss_file_kb INTEGER,
				rss_shmem_kb INTEGER,
				vm_swap_kb INTEGER,
				vol_ctxt_sw INTEGER,
				nvol_ctxt_sw INTEGER
			);
			CREATE TABLE host_snap_proc_pid_io (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER NOT NULL,
				_collected_at TEXT NOT NULL,
				pid INTEGER,
				rchar INTEGER,
				wchar INTEGER,
				syscr INTEGER,
				syscw INTEGER,
				read_bytes INTEGER,
				write_bytes INTEGER,
				cancelled_write_bytes INTEGER
			);
			CREATE TABLE host_snap_proc_pid_schedstat (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER NOT NULL,
				_collected_at TEXT NOT NULL,
				pid INTEGER,
				run_time_ns INTEGER,
				wait_time_ns INTEGER,
				timeslices INTEGER
			);
			CREATE TABLE host_snap_proc_pid_fd_count (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER NOT NULL,
				_collected_at TEXT NOT NULL,
				pid INTEGER,
				fd_count INTEGER
			);
			CREATE TABLE host_snap_proc_pid_wchan (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER NOT NULL,
				_collected_at TEXT NOT NULL,
				pid INTEGER,
				wchan TEXT
			);
		`);

		const t1 = '2026-03-30T05:57:59Z';
		const t2 = '2026-03-30T05:58:09Z';
		db.prepare(`
			INSERT INTO host_snap_proc_pid_stat (_run_id, _collected_at, pid, comm, state, cmdline, minflt, majflt, utime, stime, num_threads)
			VALUES (1, ?, 123, 'postgres', 'S', 'postgres: client backend', ?, ?, ?, ?, ?)
		`).run(t1, 10, 1, 100, 20, 2);
		db.prepare(`
			INSERT INTO host_snap_proc_pid_stat (_run_id, _collected_at, pid, comm, state, cmdline, minflt, majflt, utime, stime, num_threads)
			VALUES (1, ?, 123, 'postgres', 'R', 'postgres: client backend', ?, ?, ?, ?, ?)
		`).run(t2, 25, 3, 160, 35, 3);
		db.prepare(`
			INSERT INTO host_snap_proc_pid_status (_run_id, _collected_at, pid, name, state, fd_size, threads, vm_peak_kb, vm_size_kb, vm_rss_kb, rss_anon_kb, rss_file_kb, rss_shmem_kb, vm_swap_kb, vol_ctxt_sw, nvol_ctxt_sw)
			VALUES (1, ?, 123, 'postgres', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(t1, 'S', 64, 2, 200000, 180000, 50000, 30000, 15000, 5000, 0, 100, 10);
		db.prepare(`
			INSERT INTO host_snap_proc_pid_status (_run_id, _collected_at, pid, name, state, fd_size, threads, vm_peak_kb, vm_size_kb, vm_rss_kb, rss_anon_kb, rss_file_kb, rss_shmem_kb, vm_swap_kb, vol_ctxt_sw, nvol_ctxt_sw)
			VALUES (1, ?, 123, 'postgres', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(t2, 'R', 128, 3, 210000, 190000, 64000, 42000, 17000, 5000, 1024, 145, 30);
		db.prepare(`
			INSERT INTO host_snap_proc_pid_io (_run_id, _collected_at, pid, rchar, wchar, syscr, syscw, read_bytes, write_bytes, cancelled_write_bytes)
			VALUES (1, ?, 123, ?, ?, ?, ?, ?, ?, ?)
		`).run(t1, 1000, 2000, 10, 20, 4096, 8192, 0);
		db.prepare(`
			INSERT INTO host_snap_proc_pid_io (_run_id, _collected_at, pid, rchar, wchar, syscr, syscw, read_bytes, write_bytes, cancelled_write_bytes)
			VALUES (1, ?, 123, ?, ?, ?, ?, ?, ?, ?)
		`).run(t2, 2500, 5000, 25, 50, 20480, 32768, 1024);
		db.prepare(`
			INSERT INTO host_snap_proc_pid_schedstat (_run_id, _collected_at, pid, run_time_ns, wait_time_ns, timeslices)
			VALUES (1, ?, 123, ?, ?, ?)
		`).run(t1, 1000000, 2000000, 5);
		db.prepare(`
			INSERT INTO host_snap_proc_pid_schedstat (_run_id, _collected_at, pid, run_time_ns, wait_time_ns, timeslices)
			VALUES (1, ?, 123, ?, ?, ?)
		`).run(t2, 3000000, 7000000, 9);
		db.prepare(`INSERT INTO host_snap_proc_pid_fd_count (_run_id, _collected_at, pid, fd_count) VALUES (1, ?, 123, ?)`).run(t1, 12);
		db.prepare(`INSERT INTO host_snap_proc_pid_fd_count (_run_id, _collected_at, pid, fd_count) VALUES (1, ?, 123, ?)`).run(t2, 18);
		db.prepare(`INSERT INTO host_snap_proc_pid_wchan (_run_id, _collected_at, pid, wchan) VALUES (1, ?, 123, ?)`).run(t1, 'io_schedule');
		db.prepare(`INSERT INTO host_snap_proc_pid_wchan (_run_id, _collected_at, pid, wchan) VALUES (1, ?, 123, ?)`).run(t2, 'ep_poll');

		const telemetry = buildRunTelemetry(db, 1);
		const processes = telemetry.sections.find((section) => section.key === 'host_processes');

		expect(processes?.status).toBe('ok');
		expect(processes?.chartMetrics?.map((metric) => metric.key)).toEqual([
			'pid_123_cpu',
			'pid_123_faults',
			'pid_123_mem',
			'pid_123_io_bytes',
			'pid_123_io_chars',
			'pid_123_io_syscalls',
			'pid_123_sched',
			'pid_123_timeslices',
			'pid_123_ctx',
			'pid_123_threads',
			'pid_123_fds'
		]);
		expect(processes?.tableRows[0]).toEqual(expect.objectContaining({
			pid: 123,
			state: 'R',
			wchan: 'ep_poll',
			vm_rss_kb: 64000,
			vm_swap_kb: 1024,
			threads: 3,
			fd_count: 18,
			fd_size: 128,
			peak_vm_rss_kb: 64000,
			peak_fd_count: 18,
			wchan_sample_count: 2,
			wchan_distribution: [
				{ value: 'ep_poll', count: 1, percent: 0.5 },
				{ value: 'io_schedule', count: 1, percent: 0.5 }
			]
		}));
		expect(processes?.chartMetrics?.find((metric) => metric.key === 'pid_123_io_bytes')?.series.map((series) => series.label)).toEqual([
			'Read KB/s',
			'Write KB/s',
			'Cancelled write KB/s'
		]);
		expect(processes?.chartMetrics?.find((metric) => metric.key === 'pid_123_io_bytes')?.rawSeries?.map((series) => series.label)).toEqual([
			'Read KB',
			'Write KB',
			'Cancelled write KB'
		]);
		expect(processes?.chartMetrics?.find((metric) => metric.key === 'pid_123_io_bytes')?.rawSeries?.find((series) => series.label === 'Read KB')?.points).toEqual([
			{ t: 29000, v: 0 },
			{ t: 39000, v: 16 }
		]);
	});
});
