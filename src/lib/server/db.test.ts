import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type TableInfoRow = {
	name: string;
	type: string;
};

const SUPPORTED_SNAPSHOT_COLUMNS: Record<string, string[]> = {
	snap_pg_stat_database: [
		'datid', 'datname', 'numbackends', 'xact_commit', 'xact_rollback', 'blks_read', 'blks_hit',
		'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated', 'tup_deleted',
		'conflicts', 'temp_files', 'temp_bytes', 'deadlocks', 'checksum_failures', 'checksum_last_failure',
		'blk_read_time', 'blk_write_time', 'session_time', 'active_time', 'idle_in_transaction_time',
		'sessions', 'sessions_abandoned', 'sessions_fatal', 'sessions_killed',
		'parallel_workers_to_launch', 'parallel_workers_launched', 'stats_reset'
	],
	snap_pg_stat_bgwriter: ['buffers_clean', 'maxwritten_clean', 'buffers_alloc', 'stats_reset'],
	snap_pg_stat_checkpointer: [
		'num_timed', 'num_requested', 'num_done', 'restartpoints_timed', 'restartpoints_req',
		'restartpoints_done', 'write_time', 'sync_time', 'buffers_written', 'slru_written', 'stats_reset'
	],
	snap_pg_stat_user_tables: [
		'relid', 'schemaname', 'relname', 'seq_scan', 'last_seq_scan', 'seq_tup_read', 'idx_scan',
		'last_idx_scan', 'idx_tup_fetch', 'n_tup_ins', 'n_tup_upd', 'n_tup_del', 'n_tup_hot_upd',
		'n_tup_newpage_upd', 'n_live_tup', 'n_dead_tup', 'n_mod_since_analyze', 'n_ins_since_vacuum',
		'last_vacuum', 'last_autovacuum', 'last_analyze', 'last_autoanalyze', 'vacuum_count',
		'autovacuum_count', 'analyze_count', 'autoanalyze_count', 'total_vacuum_time',
		'total_autovacuum_time', 'total_analyze_time', 'total_autoanalyze_time'
	],
	snap_pg_stat_user_indexes: ['relid', 'indexrelid', 'schemaname', 'relname', 'indexrelname', 'idx_scan', 'last_idx_scan', 'idx_tup_read', 'idx_tup_fetch'],
	snap_pg_statio_user_tables: ['relid', 'schemaname', 'relname', 'heap_blks_read', 'heap_blks_hit', 'idx_blks_read', 'idx_blks_hit', 'toast_blks_read', 'toast_blks_hit', 'tidx_blks_read', 'tidx_blks_hit'],
	snap_pg_statio_user_indexes: ['relid', 'indexrelid', 'schemaname', 'relname', 'indexrelname', 'idx_blks_read', 'idx_blks_hit'],
	snap_pg_statio_user_sequences: ['relid', 'schemaname', 'relname', 'blks_read', 'blks_hit'],
	snap_pg_stat_database_conflicts: ['datid', 'datname', 'confl_tablespace', 'confl_lock', 'confl_snapshot', 'confl_bufferpin', 'confl_deadlock', 'confl_active_logicalslot'],
	snap_pg_stat_archiver: ['archived_count', 'last_archived_wal', 'last_archived_time', 'failed_count', 'last_failed_wal', 'last_failed_time', 'stats_reset'],
	snap_pg_stat_slru: ['name', 'blks_zeroed', 'blks_hit', 'blks_read', 'blks_written', 'blks_exists', 'flushes', 'truncates', 'stats_reset'],
	snap_pg_stat_user_functions: ['funcid', 'schemaname', 'funcname', 'calls', 'total_time', 'self_time'],
	snap_pg_stat_wal: ['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full', 'stats_reset'],
	snap_pg_stat_replication_slots: ['slot_name', 'spill_txns', 'spill_count', 'spill_bytes', 'stream_txns', 'stream_count', 'stream_bytes', 'total_txns', 'total_bytes', 'stats_reset'],
	snap_pg_stat_io: ['backend_type', 'object', 'context', 'reads', 'read_bytes', 'read_time', 'writes', 'write_bytes', 'write_time', 'writebacks', 'writeback_time', 'extends', 'extend_bytes', 'extend_time', 'hits', 'evictions', 'reuses', 'fsyncs', 'fsync_time', 'stats_reset'],
	snap_pg_stat_activity: ['datid', 'datname', 'pid', 'leader_pid', 'usesysid', 'usename', 'application_name', 'client_addr', 'client_hostname', 'client_port', 'backend_start', 'xact_start', 'query_start', 'state_change', 'wait_event_type', 'wait_event', 'state', 'backend_xid', 'backend_xmin', 'query_id', 'query', 'backend_type'],
	snap_pg_stat_replication: ['pid', 'usesysid', 'usename', 'application_name', 'client_addr', 'client_hostname', 'client_port', 'backend_start', 'backend_xmin', 'state', 'sent_lsn', 'write_lsn', 'flush_lsn', 'replay_lsn', 'write_lag', 'flush_lag', 'replay_lag', 'sync_priority', 'sync_state', 'reply_time'],
	snap_pg_stat_subscription: ['subid', 'subname', 'worker_type', 'pid', 'leader_pid', 'relid', 'received_lsn', 'last_msg_send_time', 'last_msg_receipt_time', 'latest_end_lsn', 'latest_end_time'],
	snap_pg_stat_subscription_stats: ['subid', 'subname', 'apply_error_count', 'sync_error_count', 'confl_insert_exists', 'confl_update_origin_differs', 'confl_update_exists', 'confl_update_missing', 'confl_delete_origin_differs', 'confl_delete_missing', 'confl_multiple_unique_conflicts', 'stats_reset'],
	snap_pg_stat_statements: [
		'userid', 'dbid', 'toplevel', 'queryid', 'query', 'plans', 'total_plan_time', 'min_plan_time',
		'max_plan_time', 'mean_plan_time', 'stddev_plan_time', 'calls', 'total_exec_time', 'min_exec_time',
		'max_exec_time', 'mean_exec_time', 'stddev_exec_time', 'rows', 'shared_blks_hit', 'shared_blks_read',
		'shared_blks_dirtied', 'shared_blks_written', 'local_blks_hit', 'local_blks_read', 'local_blks_dirtied',
		'local_blks_written', 'temp_blks_read', 'temp_blks_written', 'shared_blk_read_time', 'shared_blk_write_time',
		'local_blk_read_time', 'local_blk_write_time', 'temp_blk_read_time', 'temp_blk_write_time',
		'wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full', 'jit_functions', 'jit_generation_time',
		'jit_inlining_count', 'jit_inlining_time', 'jit_optimization_count', 'jit_optimization_time',
		'jit_emission_count', 'jit_emission_time', 'jit_deform_count', 'jit_deform_time',
		'parallel_workers_to_launch', 'parallel_workers_launched', 'stats_since', 'minmax_stats_since'
	]
};

const EXPECTED_SQLITE_TYPES: Record<string, Record<string, string>> = {
	snap_pg_stat_database: {
		parallel_workers_to_launch: 'INTEGER',
		parallel_workers_launched: 'INTEGER'
	},
	snap_pg_stat_checkpointer: {
		num_done: 'INTEGER',
		slru_written: 'INTEGER'
	},
	snap_pg_stat_user_tables: {
		total_vacuum_time: 'REAL',
		total_autovacuum_time: 'REAL',
		total_analyze_time: 'REAL',
		total_autoanalyze_time: 'REAL'
	},
	snap_pg_stat_io: {
		read_bytes: 'REAL',
		write_bytes: 'REAL',
		extend_bytes: 'REAL'
	},
	snap_pg_stat_subscription: {
		worker_type: 'TEXT'
	},
	snap_pg_stat_subscription_stats: {
		confl_insert_exists: 'INTEGER',
		confl_update_origin_differs: 'INTEGER',
		confl_update_exists: 'INTEGER',
		confl_update_missing: 'INTEGER',
		confl_delete_origin_differs: 'INTEGER',
		confl_delete_missing: 'INTEGER',
		confl_multiple_unique_conflicts: 'INTEGER'
	}
};

const METADATA_COLUMNS = new Set(['_id', '_run_id', '_collected_at', '_phase', '_step_id']);
const LEGACY_TABLES = ['snap_pg_stat_all_tables', 'snap_pg_stat_all_indexes', 'snap_pg_statio_all_tables'];

async function loadDbModule(dataDir: string) {
	process.env.DATA_DIR = dataDir;
	vi.resetModules();
	return await import('./db');
}

function getTableInfo(db: Database.Database, tableName: string): TableInfoRow[] {
	return db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
}

function getDataColumns(db: Database.Database, tableName: string): string[] {
	return getTableInfo(db, tableName)
		.map((col) => col.name)
		.filter((name) => !METADATA_COLUMNS.has(name));
}

function seedLegacyDb(dbPath: string) {
	const db = new Database(dbPath);
	db.exec(`
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      server_id INTEGER,
      database TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE benchmark_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL,
      database TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (id) VALUES ('snap_pg16_v1');
    INSERT INTO schema_migrations (id) VALUES ('snap_phase_v1');
    INSERT INTO schema_migrations (id) VALUES ('snap_pg_stat_statements_v2');
    CREATE TABLE snap_pg_stat_database (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL, _phase TEXT NOT NULL DEFAULT 'bench',
      datid INTEGER, datname TEXT, numbackends INTEGER,
      xact_commit INTEGER, xact_rollback INTEGER, blks_read INTEGER, blks_hit INTEGER,
      tup_returned INTEGER, tup_fetched INTEGER, tup_inserted INTEGER, tup_updated INTEGER, tup_deleted INTEGER,
      conflicts INTEGER, temp_files INTEGER, temp_bytes INTEGER,
      deadlocks INTEGER, checksum_failures INTEGER, checksum_last_failure TEXT,
      blk_read_time REAL, blk_write_time REAL,
      session_time REAL, active_time REAL, idle_in_transaction_time REAL,
      sessions INTEGER, sessions_abandoned INTEGER, sessions_fatal INTEGER, sessions_killed INTEGER,
      stats_reset TEXT,
      parallel_workers_to_launch TEXT,
      parallel_workers_launched TEXT
    );
    CREATE TABLE snap_pg_stat_checkpointer (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL, _phase TEXT NOT NULL DEFAULT 'bench',
      num_timed INTEGER, num_requested INTEGER, restartpoints_timed INTEGER, restartpoints_req INTEGER,
      restartpoints_done INTEGER, write_time REAL, sync_time REAL, buffers_written INTEGER, stats_reset TEXT,
      num_done TEXT, slru_written TEXT
    );
    CREATE TABLE snap_pg_stat_user_tables (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL, _phase TEXT NOT NULL DEFAULT 'bench',
      relid INTEGER, schemaname TEXT, relname TEXT,
      seq_scan INTEGER, last_seq_scan TEXT, seq_tup_read INTEGER,
      idx_scan INTEGER, last_idx_scan TEXT, idx_tup_fetch INTEGER,
      n_tup_ins INTEGER, n_tup_upd INTEGER, n_tup_del INTEGER,
      n_tup_hot_upd INTEGER, n_tup_newpage_upd INTEGER,
      n_live_tup INTEGER, n_dead_tup INTEGER, n_mod_since_analyze INTEGER, n_ins_since_vacuum INTEGER,
      last_vacuum TEXT, last_autovacuum TEXT, last_analyze TEXT, last_autoanalyze TEXT,
      vacuum_count INTEGER, autovacuum_count INTEGER, analyze_count INTEGER, autoanalyze_count INTEGER,
      total_vacuum_time TEXT, total_autovacuum_time TEXT, total_analyze_time TEXT, total_autoanalyze_time TEXT
    );
    CREATE TABLE snap_pg_stat_io (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL, _phase TEXT NOT NULL DEFAULT 'bench',
      backend_type TEXT, object TEXT, context TEXT,
      reads INTEGER, read_bytes INTEGER, read_time REAL,
      writes INTEGER, write_bytes INTEGER, write_time REAL,
      writebacks INTEGER, writeback_time REAL,
      extends INTEGER, extend_bytes INTEGER, extend_time REAL,
      hits INTEGER, evictions INTEGER, reuses INTEGER, fsyncs INTEGER, fsync_time REAL,
      stats_reset TEXT
    );
    CREATE TABLE snap_pg_stat_subscription (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL, _phase TEXT NOT NULL DEFAULT 'bench',
      subid INTEGER, subname TEXT, pid INTEGER, leader_pid INTEGER, relid INTEGER,
      received_lsn TEXT, last_msg_send_time TEXT, last_msg_receipt_time TEXT,
      latest_end_lsn TEXT, latest_end_time TEXT
    );
    CREATE TABLE snap_pg_stat_subscription_stats (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL, _phase TEXT NOT NULL DEFAULT 'bench',
      subid INTEGER, subname TEXT, apply_error_count INTEGER, sync_error_count INTEGER, stats_reset TEXT
    );
    CREATE TABLE snap_pg_stat_all_tables (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      _is_baseline INTEGER NOT NULL DEFAULT 0,
      relid INTEGER, schemaname TEXT, relname TEXT
    );
    CREATE TABLE snap_pg_stat_all_indexes (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      _is_baseline INTEGER NOT NULL DEFAULT 0,
      relid INTEGER, indexrelid INTEGER, schemaname TEXT, relname TEXT, indexrelname TEXT
    );
    CREATE TABLE snap_pg_statio_all_tables (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      _is_baseline INTEGER NOT NULL DEFAULT 0,
      relid INTEGER, schemaname TEXT, relname TEXT
    );
    CREATE TABLE snap_pg_stat_statements (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _step_id INTEGER,
      _collected_at TEXT NOT NULL,
      userid INTEGER,
      dbid INTEGER
    );
    INSERT INTO decisions (id, name) VALUES (1, 'decision');
    INSERT INTO designs (id, decision_id, name, database) VALUES (1, 1, 'design', 'legacy_db');
    INSERT INTO benchmark_runs (id, design_id, database) VALUES (1, 1, 'legacy_db');
    INSERT INTO snap_pg_stat_database (_run_id, _collected_at, parallel_workers_to_launch, parallel_workers_launched)
    VALUES (1, '2026-03-30T06:00:00Z', '5', '4');
    INSERT INTO snap_pg_stat_checkpointer (_run_id, _collected_at, num_done, slru_written)
    VALUES (1, '2026-03-30T06:00:00Z', '3', '2');
    INSERT INTO snap_pg_stat_user_tables (_run_id, _collected_at, total_vacuum_time)
    VALUES (1, '2026-03-30T06:00:00Z', '1.5');
    INSERT INTO snap_pg_stat_io (_run_id, _collected_at, read_bytes)
    VALUES (1, '2026-03-30T06:00:00Z', 8192);
    INSERT INTO snap_pg_stat_subscription (_run_id, _collected_at, subid, subname)
    VALUES (1, '2026-03-30T06:00:00Z', 1, 'sub');
    INSERT INTO snap_pg_stat_subscription_stats (_run_id, _collected_at, subid, subname)
    VALUES (1, '2026-03-30T06:00:00Z', 1, 'sub');
    INSERT INTO snap_pg_stat_all_tables (_run_id, _collected_at, relid, schemaname, relname)
    VALUES (1, '2026-03-30T06:00:00Z', 1, 'public', 't');
    INSERT INTO snap_pg_stat_all_indexes (_run_id, _collected_at, relid, indexrelid, schemaname, relname, indexrelname)
    VALUES (1, '2026-03-30T06:00:00Z', 1, 2, 'public', 't', 'idx');
    INSERT INTO snap_pg_statio_all_tables (_run_id, _collected_at, relid, schemaname, relname)
    VALUES (1, '2026-03-30T06:00:00Z', 1, 'public', 't');
    INSERT INTO snap_pg_stat_statements (_run_id, _collected_at, userid, dbid)
    VALUES (1, '2026-03-30T06:00:00Z', 10, 20);
  `);
	db.close();
}

describe('db snapshot schema alignment', () => {
	const originalDataDir = process.env.DATA_DIR;
	let dataDir = '';

	afterEach(() => {
		process.env.DATA_DIR = originalDataDir;
		if (dataDir) rmSync(dataDir, { recursive: true, force: true });
		dataDir = '';
	});

	it('bootstraps supported snapshot tables with the PG18 column layout', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-db-test-'));
		const dbModule = await loadDbModule(dataDir);
		const db = dbModule.getDb();

		for (const [tableName, expectedColumns] of Object.entries(SUPPORTED_SNAPSHOT_COLUMNS)) {
			expect(getDataColumns(db, tableName)).toEqual(expectedColumns);
		}

		const statIoTypes = Object.fromEntries(
			getTableInfo(db, 'snap_pg_stat_io').map((col) => [col.name, col.type])
		);
		expect(statIoTypes.read_bytes).toBe('REAL');
		expect(statIoTypes.write_bytes).toBe('REAL');
		expect(statIoTypes.extend_bytes).toBe('REAL');

		db.close();
	});

	it('resets existing snapshot tables to the PG18 schema and removes legacy tables', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-db-test-'));
		const dbPath = join(dataDir, 'mybench.db');
		seedLegacyDb(dbPath);

		const dbModule = await loadDbModule(dataDir);
		const db = dbModule.getDb();

		for (const [tableName, expectedColumns] of Object.entries(SUPPORTED_SNAPSHOT_COLUMNS)) {
			expect(getDataColumns(db, tableName)).toEqual(expectedColumns);
			const rowCount = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
			expect(rowCount.count).toBe(0);
		}

		for (const [tableName, expectedTypes] of Object.entries(EXPECTED_SQLITE_TYPES)) {
			const actualTypes = Object.fromEntries(
				getTableInfo(db, tableName).map((col) => [col.name, col.type])
			);
			for (const [columnName, expectedType] of Object.entries(expectedTypes)) {
				expect(actualTypes[columnName]).toBe(expectedType);
			}
		}

		for (const tableName of LEGACY_TABLES) {
			expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName)).toBeUndefined();
		}

		const migrationCount = db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'snap_pg18_reset_v1'
    `).get() as { count: number };
		expect(migrationCount.count).toBe(1);

		db.close();
	});

	it('runs the PG18 reset migration only once when reopening the same database', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-db-test-'));
		const dbPath = join(dataDir, 'mybench.db');
		seedLegacyDb(dbPath);

		let dbModule = await loadDbModule(dataDir);
		let db = dbModule.getDb();
		db.close();

		dbModule = await loadDbModule(dataDir);
		db = dbModule.getDb();

		const migrationCount = db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'snap_pg18_reset_v1'
    `).get() as { count: number };
		expect(migrationCount.count).toBe(1);

		const rowCount = db.prepare(`SELECT COUNT(*) AS count FROM snap_pg_stat_database`).get() as { count: number };
		expect(rowCount.count).toBe(0);

		db.close();
	});
});
