import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, 'mybench.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (!_db) {
		_db = new Database(DB_PATH);
		_db.pragma('journal_mode = WAL');
		_db.pragma('foreign_keys = ON');
		migrate(_db);
	}
	return _db;
}

function migrate(db: Database.Database) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS pg_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT 'localhost',
      port INTEGER NOT NULL DEFAULT 5432,
      username TEXT NOT NULL DEFAULT 'postgres',
      password TEXT NOT NULL DEFAULT '',
      ssl INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pg_stat_table_selections (
      server_id INTEGER NOT NULL REFERENCES pg_servers(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (server_id, table_name)
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      server_id INTEGER REFERENCES pg_servers(id),
      database TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS design_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'sql',
      script TEXT NOT NULL DEFAULT '',
      pgbench_options TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      snapshot_interval_seconds INTEGER NOT NULL DEFAULT 30,
      tps REAL,
      latency_avg_ms REAL,
      latency_stddev_ms REAL,
      transactions INTEGER
    );

    CREATE TABLE IF NOT EXISTS run_step_results (
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
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS saved_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER REFERENCES decisions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sql TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pgbench_scripts (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      step_id  INTEGER NOT NULL REFERENCES design_steps(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      name     TEXT    NOT NULL DEFAULT 'script',
      weight   INTEGER NOT NULL DEFAULT 1,
      script   TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS design_params (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      position  INTEGER NOT NULL DEFAULT 0,
      name      TEXT    NOT NULL DEFAULT '',
      value     TEXT    NOT NULL DEFAULT ''
    );
  `);

  // Add ssl column to pg_servers if it doesn't exist (idempotent)
  const hasSslCol = (db.prepare(`PRAGMA table_info(pg_servers)`).all() as { name: string }[]).some(c => c.name === 'ssl');
  if (!hasSslCol) db.exec(`ALTER TABLE pg_servers ADD COLUMN ssl INTEGER NOT NULL DEFAULT 0`);

  // Add command + processed_script to run_step_results (idempotent)
  const stepResultCols = (db.prepare(`PRAGMA table_info(run_step_results)`).all() as { name: string }[]).map(c => c.name);
  if (!stepResultCols.includes('command')) db.exec(`ALTER TABLE run_step_results ADD COLUMN command TEXT NOT NULL DEFAULT ''`);
  if (!stepResultCols.includes('processed_script')) db.exec(`ALTER TABLE run_step_results ADD COLUMN processed_script TEXT NOT NULL DEFAULT ''`);

  // One-time backfill: migrate existing pgbench step scripts (idempotent)
  db.exec(`
    INSERT INTO pgbench_scripts (step_id, position, name, weight, script)
    SELECT id, 0, 'script', 100, script
    FROM design_steps
    WHERE type = 'pgbench' AND script != ''
      AND id NOT IN (SELECT DISTINCT step_id FROM pgbench_scripts);

    UPDATE pgbench_scripts SET weight = 100 WHERE weight = 1;
  `);

	// Schema migrations tracker
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

	// Migration: drop and recreate all snap_ tables with correct PG16 schema
	const snapMigrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = 'snap_pg16_v1'`).get();
	if (!snapMigrated) {
		db.exec(`
      DROP TABLE IF EXISTS snap_pg_stat_database;
      DROP TABLE IF EXISTS snap_pg_stat_bgwriter;
      DROP TABLE IF EXISTS snap_pg_stat_user_tables;
      DROP TABLE IF EXISTS snap_pg_stat_user_indexes;
      DROP TABLE IF EXISTS snap_pg_statio_user_tables;
      DROP TABLE IF EXISTS snap_pg_statio_user_indexes;
      DROP TABLE IF EXISTS snap_pg_statio_user_sequences;
      DROP TABLE IF EXISTS snap_pg_stat_database_conflicts;
      DROP TABLE IF EXISTS snap_pg_stat_archiver;
      DROP TABLE IF EXISTS snap_pg_stat_slru;
      DROP TABLE IF EXISTS snap_pg_stat_user_functions;
      DROP TABLE IF EXISTS snap_pg_stat_wal;
      DROP TABLE IF EXISTS snap_pg_stat_replication_slots;
      DROP TABLE IF EXISTS snap_pg_stat_io;
      DROP TABLE IF EXISTS snap_pg_stat_activity;
      DROP TABLE IF EXISTS snap_pg_stat_replication;
      DROP TABLE IF EXISTS snap_pg_stat_subscription;
      DROP TABLE IF EXISTS snap_pg_stat_subscription_stats;

      -- pg_stat_database (PG16)
      CREATE TABLE snap_pg_stat_database (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        datid INTEGER, datname TEXT, numbackends INTEGER,
        xact_commit INTEGER, xact_rollback INTEGER,
        blks_read INTEGER, blks_hit INTEGER,
        tup_returned INTEGER, tup_fetched INTEGER, tup_inserted INTEGER, tup_updated INTEGER, tup_deleted INTEGER,
        conflicts INTEGER, temp_files INTEGER, temp_bytes INTEGER,
        deadlocks INTEGER, checksum_failures INTEGER, checksum_last_failure TEXT,
        blk_read_time REAL, blk_write_time REAL,
        session_time REAL, active_time REAL, idle_in_transaction_time REAL,
        sessions INTEGER, sessions_abandoned INTEGER, sessions_fatal INTEGER, sessions_killed INTEGER,
        stats_reset TEXT
      );

      -- pg_stat_bgwriter (PG16)
      CREATE TABLE snap_pg_stat_bgwriter (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        checkpoints_timed INTEGER, checkpoints_req INTEGER,
        checkpoint_write_time REAL, checkpoint_sync_time REAL,
        buffers_checkpoint INTEGER, buffers_clean INTEGER, maxwritten_clean INTEGER,
        buffers_backend INTEGER, buffers_backend_fsync INTEGER, buffers_alloc INTEGER,
        stats_reset TEXT
      );

      -- pg_stat_user_tables (PG16)
      CREATE TABLE snap_pg_stat_user_tables (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        relid INTEGER, schemaname TEXT, relname TEXT,
        seq_scan INTEGER, last_seq_scan TEXT, seq_tup_read INTEGER,
        idx_scan INTEGER, last_idx_scan TEXT, idx_tup_fetch INTEGER,
        n_tup_ins INTEGER, n_tup_upd INTEGER, n_tup_del INTEGER,
        n_tup_hot_upd INTEGER, n_tup_newpage_upd INTEGER,
        n_live_tup INTEGER, n_dead_tup INTEGER, n_mod_since_analyze INTEGER, n_ins_since_vacuum INTEGER,
        last_vacuum TEXT, last_autovacuum TEXT, last_analyze TEXT, last_autoanalyze TEXT,
        vacuum_count INTEGER, autovacuum_count INTEGER, analyze_count INTEGER, autoanalyze_count INTEGER
      );

      -- pg_stat_user_indexes (PG16)
      CREATE TABLE snap_pg_stat_user_indexes (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        relid INTEGER, indexrelid INTEGER, schemaname TEXT, relname TEXT, indexrelname TEXT,
        idx_scan INTEGER, last_idx_scan TEXT, idx_tup_read INTEGER, idx_tup_fetch INTEGER
      );

      -- pg_statio_user_tables (PG16)
      CREATE TABLE snap_pg_statio_user_tables (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        relid INTEGER, schemaname TEXT, relname TEXT,
        heap_blks_read INTEGER, heap_blks_hit INTEGER,
        idx_blks_read INTEGER, idx_blks_hit INTEGER,
        toast_blks_read INTEGER, toast_blks_hit INTEGER,
        tidx_blks_read INTEGER, tidx_blks_hit INTEGER
      );

      -- pg_statio_user_indexes (PG16)
      CREATE TABLE snap_pg_statio_user_indexes (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        relid INTEGER, indexrelid INTEGER, schemaname TEXT, relname TEXT, indexrelname TEXT,
        idx_blks_read INTEGER, idx_blks_hit INTEGER
      );

      -- pg_statio_user_sequences (PG16)
      CREATE TABLE snap_pg_statio_user_sequences (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        relid INTEGER, schemaname TEXT, relname TEXT,
        blks_read INTEGER, blks_hit INTEGER
      );

      -- pg_stat_database_conflicts (PG16)
      CREATE TABLE snap_pg_stat_database_conflicts (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        datid INTEGER, datname TEXT,
        confl_tablespace INTEGER, confl_lock INTEGER, confl_snapshot INTEGER,
        confl_bufferpin INTEGER, confl_deadlock INTEGER, confl_active_logicalslot INTEGER
      );

      -- pg_stat_archiver (PG16)
      CREATE TABLE snap_pg_stat_archiver (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        archived_count INTEGER, last_archived_wal TEXT, last_archived_time TEXT,
        failed_count INTEGER, last_failed_wal TEXT, last_failed_time TEXT,
        stats_reset TEXT
      );

      -- pg_stat_slru (PG16)
      CREATE TABLE snap_pg_stat_slru (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        name TEXT, blks_zeroed INTEGER, blks_hit INTEGER, blks_read INTEGER,
        blks_written INTEGER, blks_exists INTEGER, flushes INTEGER, truncates INTEGER,
        stats_reset TEXT
      );

      -- pg_stat_user_functions (PG16)
      CREATE TABLE snap_pg_stat_user_functions (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        funcid INTEGER, schemaname TEXT, funcname TEXT,
        calls INTEGER, total_time REAL, self_time REAL
      );

      -- pg_stat_wal (PG16)
      CREATE TABLE snap_pg_stat_wal (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        wal_records INTEGER, wal_fpi INTEGER, wal_bytes REAL,
        wal_buffers_full INTEGER, wal_write INTEGER, wal_sync INTEGER,
        wal_write_time REAL, wal_sync_time REAL, stats_reset TEXT
      );

      -- pg_stat_replication_slots (PG16)
      CREATE TABLE snap_pg_stat_replication_slots (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        slot_name TEXT, spill_txns INTEGER, spill_count INTEGER, spill_bytes INTEGER,
        stream_txns INTEGER, stream_count INTEGER, stream_bytes INTEGER,
        total_txns INTEGER, total_bytes INTEGER, stats_reset TEXT
      );

      -- pg_stat_io (PG16)
      CREATE TABLE snap_pg_stat_io (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        backend_type TEXT, object TEXT, context TEXT,
        reads INTEGER, read_time REAL, writes INTEGER, write_time REAL,
        writebacks INTEGER, writeback_time REAL, extends INTEGER, extend_time REAL,
        op_bytes INTEGER, hits INTEGER, evictions INTEGER, reuses INTEGER, fsyncs INTEGER, fsync_time REAL,
        stats_reset TEXT
      );

      -- pg_stat_activity (PG16)
      CREATE TABLE snap_pg_stat_activity (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        datid INTEGER, datname TEXT, pid INTEGER, leader_pid INTEGER,
        usesysid INTEGER, usename TEXT, application_name TEXT,
        client_addr TEXT, client_hostname TEXT, client_port INTEGER,
        backend_start TEXT, xact_start TEXT, query_start TEXT, state_change TEXT,
        wait_event_type TEXT, wait_event TEXT, state TEXT,
        backend_xid TEXT, backend_xmin TEXT, query_id INTEGER, query TEXT,
        backend_type TEXT
      );

      -- pg_stat_replication (PG16)
      CREATE TABLE snap_pg_stat_replication (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        pid INTEGER, usesysid INTEGER, usename TEXT, application_name TEXT,
        client_addr TEXT, client_hostname TEXT, client_port INTEGER,
        backend_start TEXT, backend_xmin TEXT, state TEXT,
        sent_lsn TEXT, write_lsn TEXT, flush_lsn TEXT, replay_lsn TEXT,
        write_lag TEXT, flush_lag TEXT, replay_lag TEXT,
        sync_priority INTEGER, sync_state TEXT, reply_time TEXT
      );

      -- pg_stat_subscription (PG16) — no worker_type in PG16
      CREATE TABLE snap_pg_stat_subscription (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        subid INTEGER, subname TEXT,
        pid INTEGER, leader_pid INTEGER, relid INTEGER,
        received_lsn TEXT, last_msg_send_time TEXT, last_msg_receipt_time TEXT,
        latest_end_lsn TEXT, latest_end_time TEXT
      );

      -- pg_stat_subscription_stats (PG16)
      CREATE TABLE snap_pg_stat_subscription_stats (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _is_baseline INTEGER NOT NULL DEFAULT 0,
        subid INTEGER, subname TEXT,
        apply_error_count INTEGER, sync_error_count INTEGER, stats_reset TEXT
      );

      INSERT INTO schema_migrations (id) VALUES ('snap_pg16_v1');
    `);
	}

	// Seed default saved queries
	const count = (db.prepare('SELECT COUNT(*) as c FROM saved_queries WHERE decision_id IS NULL').get() as { c: number }).c;
	if (count === 0) {
		const insert = db.prepare(`INSERT INTO saved_queries (decision_id, name, sql) VALUES (NULL, ?, ?)`);
		const seedMany = db.transaction(() => {
			insert.run(
				'Buffer hit ratio',
				`SELECT round(blks_hit*1.0/(NULLIF(blks_hit+blks_read, 0)), 4) AS hit_ratio
FROM snap_pg_stat_database WHERE _run_id = ? AND datname NOT IN ('template0','template1')
ORDER BY _collected_at DESC LIMIT 1`
			);
			insert.run(
				'Index scan ratio',
				`SELECT schemaname||'.'||relname AS table_name,
  round(idx_scan*1.0/(NULLIF(idx_scan+seq_scan,0)), 4) AS idx_ratio
FROM snap_pg_stat_user_tables WHERE _run_id = ?
ORDER BY _collected_at DESC LIMIT 10`
			);
			insert.run(
				'Checkpoint write time',
				`SELECT checkpoint_write_time, checkpoint_sync_time, checkpoints_req, checkpoints_timed
FROM snap_pg_stat_bgwriter WHERE _run_id = ? ORDER BY _collected_at DESC LIMIT 1`
			);
		});
		seedMany();
	}
}

export default getDb;
