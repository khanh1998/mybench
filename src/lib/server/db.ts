import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PG_STAT_STATEMENTS_SQLITE_COLUMNS } from './pg-stat-statements-schema';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, 'mybench.db');
const OLD_DEFAULT_PERF_EVENTS =
	'cycles,instructions,cache-references,cache-misses,branches,branch-misses,context-switches,page-faults';
const DEFAULT_PERF_EVENTS =
	'task-clock,cpu-clock,context-switches,cpu-migrations,page-faults,minor-faults,major-faults';

let _db: Database.Database | null = null;

function migrateRunStepPerfUniqueConstraint(db: Database.Database): void {
	type IndexRow = { name: string; unique: number };
	type IndexInfoRow = { seqno: number; name: string };
	const indexes = db.prepare(`PRAGMA index_list(run_step_perf)`).all() as IndexRow[];
	const hasModeUnique = indexes.some((idx) => {
		if (!idx.unique) return false;
		const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as IndexInfoRow[])
			.sort((a, b) => a.seqno - b.seqno)
			.map((col) => col.name);
		return cols.join(',') === 'run_id,step_id,mode';
	});
	if (hasModeUnique) return;

	const hasOldUnique = indexes.some((idx) => {
		if (!idx.unique) return false;
		const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as IndexInfoRow[])
			.sort((a, b) => a.seqno - b.seqno)
			.map((col) => col.name);
		return cols.join(',') === 'run_id,step_id';
	});
	const tableSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_step_perf'`).get() as { sql: string } | undefined)?.sql ?? '';
	if (!hasOldUnique && !tableSql.includes('UNIQUE(run_id, step_id)')) return;

	db.exec(`
    ALTER TABLE run_step_perf RENAME TO run_step_perf_old;
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
      mode TEXT NOT NULL DEFAULT 'stat',
      result_json TEXT NOT NULL DEFAULT '',
      perf_script_output TEXT NOT NULL DEFAULT '',
      warnings_json TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(run_id, step_id, mode)
    );
    INSERT INTO run_step_perf (
      id, run_id, step_id, status, scope, cgroup, command, raw_output, raw_error,
      mode, result_json, perf_script_output, warnings_json, started_at, finished_at
    )
    SELECT
      id, run_id, step_id, status, scope, cgroup, command, raw_output, raw_error,
      mode, result_json, perf_script_output, warnings_json, started_at, finished_at
    FROM run_step_perf_old;
    DROP TABLE run_step_perf_old;
  `);
}

function createSnapPgStatStatementsTableSql(): string {
	const dataColumns = PG_STAT_STATEMENTS_SQLITE_COLUMNS.map(
		([name, type]) => `${name} ${type}`
	).join(',\n      ');

	return `
    CREATE TABLE snap_pg_stat_statements (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _step_id INTEGER,
      _collected_at TEXT NOT NULL,
      ${dataColumns}
    )
  `;
}

function createSnapPgStatBgwriterTableSql(tableName = 'snap_pg_stat_bgwriter', phaseColumnSql = `_phase TEXT NOT NULL DEFAULT 'bench'`): string {
	return `
    CREATE TABLE ${tableName} (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      ${phaseColumnSql},
      buffers_clean INTEGER,
      maxwritten_clean INTEGER,
      buffers_alloc INTEGER,
      stats_reset TEXT
    )
  `;
}

function createSnapPgStatCheckpointerTableSql(tableName = 'snap_pg_stat_checkpointer', phaseColumnSql = `_phase TEXT NOT NULL DEFAULT 'bench'`): string {
	return `
    CREATE TABLE ${tableName} (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      ${phaseColumnSql},
      num_timed INTEGER,
      num_requested INTEGER,
      num_done INTEGER,
      restartpoints_timed INTEGER,
      restartpoints_req INTEGER,
      restartpoints_done INTEGER,
      write_time REAL,
      sync_time REAL,
      buffers_written INTEGER,
      slru_written INTEGER,
      stats_reset TEXT
    )
  `;
}

function createSnapPgStatWalTableSql(tableName = 'snap_pg_stat_wal', phaseColumnSql = `_phase TEXT NOT NULL DEFAULT 'bench'`): string {
	return `
    CREATE TABLE ${tableName} (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      ${phaseColumnSql},
      wal_records INTEGER,
      wal_fpi INTEGER,
      wal_bytes REAL,
      wal_buffers_full INTEGER,
      stats_reset TEXT
    )
  `;
}

function createSnapPgStatIoTableSql(tableName = 'snap_pg_stat_io', phaseColumnSql = `_phase TEXT NOT NULL DEFAULT 'bench'`): string {
	return `
    CREATE TABLE ${tableName} (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      ${phaseColumnSql},
      backend_type TEXT,
      object TEXT,
      context TEXT,
      reads INTEGER,
      read_bytes REAL,
      read_time REAL,
      writes INTEGER,
      write_bytes REAL,
      write_time REAL,
      writebacks INTEGER,
      writeback_time REAL,
      extends INTEGER,
      extend_bytes REAL,
      extend_time REAL,
      hits INTEGER,
      evictions INTEGER,
      reuses INTEGER,
      fsyncs INTEGER,
      fsync_time REAL,
      stats_reset TEXT
    )
  `;
}

function createSnapPgLocksTableSql(tableName = 'snap_pg_locks', phaseColumnSql = `_phase TEXT NOT NULL DEFAULT 'bench'`): string {
	return `
    CREATE TABLE ${tableName} (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      ${phaseColumnSql},
      locktype TEXT,
      database INTEGER,
      relation INTEGER,
      page INTEGER,
      tuple INTEGER,
      virtualxid TEXT,
      transactionid TEXT,
      classid INTEGER,
      objid INTEGER,
      objsubid INTEGER,
      virtualtransaction TEXT,
      pid INTEGER,
      mode TEXT,
      granted INTEGER,
      fastpath INTEGER,
      waitstart TEXT
    )
  `;
}

function createSupportedSnapTablesSql(phaseColumnSql = `_phase TEXT NOT NULL DEFAULT 'bench'`): string {
	return `
      CREATE TABLE snap_pg_stat_database (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        datid INTEGER, datname TEXT, numbackends INTEGER,
        xact_commit INTEGER, xact_rollback INTEGER, blks_read INTEGER, blks_hit INTEGER,
        tup_returned INTEGER, tup_fetched INTEGER, tup_inserted INTEGER, tup_updated INTEGER, tup_deleted INTEGER,
        conflicts INTEGER, temp_files INTEGER, temp_bytes INTEGER,
        deadlocks INTEGER, checksum_failures INTEGER, checksum_last_failure TEXT,
        blk_read_time REAL, blk_write_time REAL,
        session_time REAL, active_time REAL, idle_in_transaction_time REAL,
        sessions INTEGER, sessions_abandoned INTEGER, sessions_fatal INTEGER, sessions_killed INTEGER,
        parallel_workers_to_launch INTEGER, parallel_workers_launched INTEGER,
        stats_reset TEXT
      );

      ${createSnapPgStatBgwriterTableSql('snap_pg_stat_bgwriter', phaseColumnSql)};
      ${createSnapPgStatCheckpointerTableSql('snap_pg_stat_checkpointer', phaseColumnSql)};

      CREATE TABLE snap_pg_stat_user_tables (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        relid INTEGER, schemaname TEXT, relname TEXT,
        seq_scan INTEGER, last_seq_scan TEXT, seq_tup_read INTEGER,
        idx_scan INTEGER, last_idx_scan TEXT, idx_tup_fetch INTEGER,
        n_tup_ins INTEGER, n_tup_upd INTEGER, n_tup_del INTEGER,
        n_tup_hot_upd INTEGER, n_tup_newpage_upd INTEGER,
        n_live_tup INTEGER, n_dead_tup INTEGER, n_mod_since_analyze INTEGER, n_ins_since_vacuum INTEGER,
        last_vacuum TEXT, last_autovacuum TEXT, last_analyze TEXT, last_autoanalyze TEXT,
        vacuum_count INTEGER, autovacuum_count INTEGER, analyze_count INTEGER, autoanalyze_count INTEGER,
        total_vacuum_time REAL, total_autovacuum_time REAL, total_analyze_time REAL, total_autoanalyze_time REAL
      );

      CREATE TABLE snap_pg_stat_user_indexes (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        relid INTEGER, indexrelid INTEGER, schemaname TEXT, relname TEXT, indexrelname TEXT,
        idx_scan INTEGER, last_idx_scan TEXT, idx_tup_read INTEGER, idx_tup_fetch INTEGER
      );

      CREATE TABLE snap_pg_statio_user_tables (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        relid INTEGER, schemaname TEXT, relname TEXT,
        heap_blks_read INTEGER, heap_blks_hit INTEGER,
        idx_blks_read INTEGER, idx_blks_hit INTEGER,
        toast_blks_read INTEGER, toast_blks_hit INTEGER,
        tidx_blks_read INTEGER, tidx_blks_hit INTEGER
      );

      CREATE TABLE snap_pg_statio_user_indexes (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        relid INTEGER, indexrelid INTEGER, schemaname TEXT, relname TEXT, indexrelname TEXT,
        idx_blks_read INTEGER, idx_blks_hit INTEGER
      );

      CREATE TABLE snap_pg_statio_user_sequences (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        relid INTEGER, schemaname TEXT, relname TEXT,
        blks_read INTEGER, blks_hit INTEGER
      );

      CREATE TABLE snap_pg_stat_database_conflicts (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        datid INTEGER, datname TEXT,
        confl_tablespace INTEGER, confl_lock INTEGER, confl_snapshot INTEGER,
        confl_bufferpin INTEGER, confl_deadlock INTEGER, confl_active_logicalslot INTEGER
      );

      CREATE TABLE snap_pg_stat_archiver (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        archived_count INTEGER, last_archived_wal TEXT, last_archived_time TEXT,
        failed_count INTEGER, last_failed_wal TEXT, last_failed_time TEXT,
        stats_reset TEXT
      );

      CREATE TABLE snap_pg_stat_slru (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        name TEXT, blks_zeroed INTEGER, blks_hit INTEGER, blks_read INTEGER,
        blks_written INTEGER, blks_exists INTEGER, flushes INTEGER, truncates INTEGER,
        stats_reset TEXT
      );

      CREATE TABLE snap_pg_stat_user_functions (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        funcid INTEGER, schemaname TEXT, funcname TEXT,
        calls INTEGER, total_time REAL, self_time REAL
      );

      ${createSnapPgStatWalTableSql('snap_pg_stat_wal', phaseColumnSql)};

      CREATE TABLE snap_pg_stat_replication_slots (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        slot_name TEXT, spill_txns INTEGER, spill_count INTEGER, spill_bytes INTEGER,
        stream_txns INTEGER, stream_count INTEGER, stream_bytes INTEGER,
        total_txns INTEGER, total_bytes INTEGER, stats_reset TEXT
      );

      ${createSnapPgStatIoTableSql('snap_pg_stat_io', phaseColumnSql)};

      CREATE TABLE snap_pg_stat_activity (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        datid INTEGER, datname TEXT, pid INTEGER, leader_pid INTEGER,
        usesysid INTEGER, usename TEXT, application_name TEXT,
        client_addr TEXT, client_hostname TEXT, client_port INTEGER,
        backend_start TEXT, xact_start TEXT, query_start TEXT, state_change TEXT,
        wait_event_type TEXT, wait_event TEXT, state TEXT,
        backend_xid TEXT, backend_xmin TEXT, query_id INTEGER, query TEXT,
        backend_type TEXT
      );

      CREATE TABLE snap_pg_stat_replication (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        pid INTEGER, usesysid INTEGER, usename TEXT, application_name TEXT,
        client_addr TEXT, client_hostname TEXT, client_port INTEGER,
        backend_start TEXT, backend_xmin TEXT, state TEXT,
        sent_lsn TEXT, write_lsn TEXT, flush_lsn TEXT, replay_lsn TEXT,
        write_lag TEXT, flush_lag TEXT, replay_lag TEXT,
        sync_priority INTEGER, sync_state TEXT, reply_time TEXT
      );

      CREATE TABLE snap_pg_stat_subscription (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        subid INTEGER, subname TEXT, worker_type TEXT, pid INTEGER, leader_pid INTEGER, relid INTEGER,
        received_lsn TEXT, last_msg_send_time TEXT, last_msg_receipt_time TEXT,
        latest_end_lsn TEXT, latest_end_time TEXT
      );

      CREATE TABLE snap_pg_stat_subscription_stats (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        ${phaseColumnSql},
        subid INTEGER, subname TEXT,
        apply_error_count INTEGER, sync_error_count INTEGER,
        confl_insert_exists INTEGER, confl_update_origin_differs INTEGER, confl_update_exists INTEGER,
        confl_update_missing INTEGER, confl_delete_origin_differs INTEGER, confl_delete_missing INTEGER,
        confl_multiple_unique_conflicts INTEGER,
        stats_reset TEXT
      );
  `;
}

function resetSupportedPg18SnapTables(db: Database.Database): void {
	db.exec(`
    DROP TABLE IF EXISTS snap_pg_stat_database;
    DROP TABLE IF EXISTS snap_pg_stat_bgwriter;
    DROP TABLE IF EXISTS snap_pg_stat_checkpointer;
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
    DROP TABLE IF EXISTS snap_pg_stat_all_tables;
    DROP TABLE IF EXISTS snap_pg_stat_all_indexes;
    DROP TABLE IF EXISTS snap_pg_statio_all_tables;
  `);
	db.exec(createSupportedSnapTablesSql());
}

function tableExists(db: Database.Database, tableName: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
}

function migrateBgwriterAndCheckpointerTables(db: Database.Database): void {
	const bgwriterMigrationId = 'snap_bgwriter_checkpointer_v1';
	const migrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = ?`).get(bgwriterMigrationId);
	if (migrated) return;

	if (tableExists(db, 'snap_pg_stat_bgwriter')) {
		const tempTable = 'snap_pg_stat_bgwriter__next';
		db.exec(`DROP TABLE IF EXISTS ${tempTable}`);
		db.exec(createSnapPgStatBgwriterTableSql(tempTable));

		const existingCols = new Set(
			(db.prepare(`PRAGMA table_info(snap_pg_stat_bgwriter)`).all() as { name: string }[]).map((col) => col.name)
		);
		const targetCols: string[] = [];
		const sourceExprs: string[] = [];
		const copyColumn = (target: string, source = target) => {
			if (existingCols.has(source)) {
				targetCols.push(target);
				sourceExprs.push(source);
			}
		};

		copyColumn('_run_id');
		copyColumn('_collected_at');
		if (existingCols.has('_phase')) {
			targetCols.push('_phase');
			sourceExprs.push('_phase');
		} else if (existingCols.has('_is_baseline')) {
			targetCols.push('_phase');
			sourceExprs.push(`CASE WHEN _is_baseline = 1 THEN 'pre' ELSE 'bench' END`);
		}
		copyColumn('buffers_clean');
		copyColumn('maxwritten_clean');
		copyColumn('buffers_alloc');
		copyColumn('stats_reset');

		if (targetCols.length > 0) {
			db.exec(`
        INSERT INTO ${tempTable} (${targetCols.join(', ')})
        SELECT ${sourceExprs.join(', ')}
        FROM snap_pg_stat_bgwriter
      `);
		}

		db.exec(`
      DROP TABLE snap_pg_stat_bgwriter;
      ALTER TABLE ${tempTable} RENAME TO snap_pg_stat_bgwriter;
    `);
	} else {
		db.exec(createSnapPgStatBgwriterTableSql());
	}

	db.exec(createSnapPgStatCheckpointerTableSql().replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
	db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run(bgwriterMigrationId);
}

function migrateBgwriterQueriesAndMetrics(db: Database.Database): void {
	const migrationId = 'bgwriter_metric_queries_v1';
	const migrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = ?`).get(migrationId);
	if (migrated) return;

	db.prepare(`
    UPDATE saved_queries
    SET name = ?, sql = ?
    WHERE decision_id IS NULL AND name = ?
  `).run(
		'BGWriter stats',
		`SELECT buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
FROM snap_pg_stat_bgwriter WHERE _run_id = ? ORDER BY _collected_at DESC LIMIT 1`,
		'Checkpoint write time'
	);

	db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run(migrationId);
}

function backfillPgStatCheckpointerSelections(db: Database.Database): void {
	const migrationId = 'pg_stat_checkpointer_selection_v1';
	const migrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = ?`).get(migrationId);
	if (migrated) return;

	db.exec(`
    INSERT OR IGNORE INTO pg_stat_table_selections (server_id, table_name, enabled)
    SELECT id, 'pg_stat_checkpointer', 1
    FROM pg_servers
  `);

	db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run(migrationId);
}

function migratePg18WalAndIoTables(db: Database.Database): void {
	const migrationId = 'snap_pg18_wal_io_v1';
	const migrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = ?`).get(migrationId);
	if (migrated) return;

	db.exec(`
    DROP TABLE IF EXISTS snap_pg_stat_wal;
    DROP TABLE IF EXISTS snap_pg_stat_io;
  `);
	db.exec(createSnapPgStatWalTableSql());
	db.exec(createSnapPgStatIoTableSql());
	db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run(migrationId);
}

function migratePgLocksWaitstartColumn(db: Database.Database): void {
	if (!tableExists(db, 'snap_pg_locks')) return;

	const lockCols = (db.prepare(`PRAGMA table_info(snap_pg_locks)`).all() as { name: string }[]).map(
		(col) => col.name
	);
	if (!lockCols.includes('waitstart')) {
		db.exec(`ALTER TABLE snap_pg_locks ADD COLUMN waitstart TEXT`);
	}
}

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
      ssl INTEGER NOT NULL DEFAULT 0,
      perf_enabled INTEGER NOT NULL DEFAULT 0,
      perf_scope TEXT NOT NULL DEFAULT 'disabled',
      perf_cgroup TEXT NOT NULL DEFAULT '',
      perf_events TEXT NOT NULL DEFAULT 'task-clock,cpu-clock,context-switches,cpu-migrations,page-faults,minor-faults,major-faults',
      perf_status_json TEXT NOT NULL DEFAULT ''
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
      database TEXT NOT NULL DEFAULT '',
      pre_collect_secs INTEGER NOT NULL DEFAULT 0,
      post_collect_secs INTEGER NOT NULL DEFAULT 60,
      snapshot_interval_seconds INTEGER NOT NULL DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS design_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'sql',
      script TEXT NOT NULL DEFAULT '',
      pgbench_options TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      duration_secs INTEGER NOT NULL DEFAULT 0,
      no_transaction INTEGER NOT NULL DEFAULT 0,
      collect_perf INTEGER NOT NULL DEFAULT 0,
      perf_duration TEXT NOT NULL DEFAULT '',
      perf_stat_duration TEXT NOT NULL DEFAULT '',
      perf_record_duration TEXT NOT NULL DEFAULT '',
      perf_trace_duration TEXT NOT NULL DEFAULT '',
      perf_stat_enabled INTEGER NOT NULL DEFAULT 0,
      perf_record_enabled INTEGER NOT NULL DEFAULT 0,
      perf_trace_enabled INTEGER NOT NULL DEFAULT 0,
      perf_delay TEXT NOT NULL DEFAULT '',
      perf_stat_delay TEXT NOT NULL DEFAULT '',
      perf_record_delay TEXT NOT NULL DEFAULT '',
      perf_trace_delay TEXT NOT NULL DEFAULT '',
      perf_mode TEXT NOT NULL DEFAULT 'stat',
      perf_cgroup TEXT NOT NULL DEFAULT '',
      perf_events TEXT NOT NULL DEFAULT '',
      perf_repeat TEXT NOT NULL DEFAULT '',
      perf_freq TEXT NOT NULL DEFAULT '',
      perf_call_graph TEXT NOT NULL DEFAULT 'dwarf',
      perf_mmap_pages TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS benchmark_runs (
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
      command TEXT NOT NULL DEFAULT '',
      processed_script TEXT NOT NULL DEFAULT '',
      pgbench_summary_json TEXT NOT NULL DEFAULT '',
      pgbench_scripts_json TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run_step_perf (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      step_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'disabled',
      cgroup TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      raw_output TEXT NOT NULL DEFAULT '',
      raw_error TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'stat',
      result_json TEXT NOT NULL DEFAULT '',
      perf_script_output TEXT NOT NULL DEFAULT '',
      warnings_json TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(run_id, step_id, mode)
    );

    CREATE TABLE IF NOT EXISTS run_step_perf_events (
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

    CREATE TABLE IF NOT EXISTS sysbench_system_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pg_server_id INTEGER NOT NULL REFERENCES pg_servers(id) ON DELETE CASCADE,
      pg_server_name TEXT NOT NULL DEFAULT '',
      test_type TEXT NOT NULL,
      flags TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      exit_code INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS design_param_profiles (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      name      TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS design_param_profile_values (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES design_param_profiles(id) ON DELETE CASCADE,
      param_name TEXT    NOT NULL DEFAULT '',
      value      TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ec2_servers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      host        TEXT    NOT NULL DEFAULT '',
      user        TEXT    NOT NULL DEFAULT 'ec2-user',
      port        INTEGER NOT NULL DEFAULT 22,
      private_key TEXT    NOT NULL DEFAULT '',
      remote_dir   TEXT    NOT NULL DEFAULT '~/mybench-bench',
      log_dir      TEXT    NOT NULL DEFAULT '/tmp/mybench-logs',
      cli_log_dir  TEXT    NOT NULL DEFAULT '/tmp/gocli-logs'
    );
  `);

  // Add ssl column to pg_servers if it doesn't exist (idempotent)
  const hasSslCol = (db.prepare(`PRAGMA table_info(pg_servers)`).all() as { name: string }[]).some(c => c.name === 'ssl');
  if (!hasSslCol) db.exec(`ALTER TABLE pg_servers ADD COLUMN ssl INTEGER NOT NULL DEFAULT 0`);

  // Add step detail columns to run_step_results (idempotent)
  const stepResultCols = (db.prepare(`PRAGMA table_info(run_step_results)`).all() as { name: string }[]).map(c => c.name);
  if (!stepResultCols.includes('command')) db.exec(`ALTER TABLE run_step_results ADD COLUMN command TEXT NOT NULL DEFAULT ''`);
  if (!stepResultCols.includes('processed_script')) db.exec(`ALTER TABLE run_step_results ADD COLUMN processed_script TEXT NOT NULL DEFAULT ''`);
  if (!stepResultCols.includes('pgbench_summary_json')) db.exec(`ALTER TABLE run_step_results ADD COLUMN pgbench_summary_json TEXT NOT NULL DEFAULT ''`);
  if (!stepResultCols.includes('pgbench_scripts_json')) db.exec(`ALTER TABLE run_step_results ADD COLUMN pgbench_scripts_json TEXT NOT NULL DEFAULT ''`);
  if (!stepResultCols.includes('sysbench_summary_json')) db.exec(`ALTER TABLE run_step_results ADD COLUMN sysbench_summary_json TEXT NOT NULL DEFAULT ''`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_step_perf (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      step_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'disabled',
      cgroup TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      raw_output TEXT NOT NULL DEFAULT '',
      raw_error TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'stat',
      result_json TEXT NOT NULL DEFAULT '',
      perf_script_output TEXT NOT NULL DEFAULT '',
      warnings_json TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(run_id, step_id, mode)
    );
    CREATE TABLE IF NOT EXISTS run_step_perf_events (
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

  const perfEventCols = (db.prepare(`PRAGMA table_info(run_step_perf_events)`).all() as { name: string }[]).map(c => c.name);
  if (!perfEventCols.includes('derived_value')) db.exec(`ALTER TABLE run_step_perf_events ADD COLUMN derived_value REAL`);
  if (!perfEventCols.includes('derived_unit')) db.exec(`ALTER TABLE run_step_perf_events ADD COLUMN derived_unit TEXT NOT NULL DEFAULT ''`);
  const perfCols = (db.prepare(`PRAGMA table_info(run_step_perf)`).all() as { name: string }[]).map(c => c.name);
  if (!perfCols.includes('mode')) db.exec(`ALTER TABLE run_step_perf ADD COLUMN mode TEXT NOT NULL DEFAULT 'stat'`);
  if (!perfCols.includes('result_json')) db.exec(`ALTER TABLE run_step_perf ADD COLUMN result_json TEXT NOT NULL DEFAULT ''`);
  if (!perfCols.includes('perf_script_output')) db.exec(`ALTER TABLE run_step_perf ADD COLUMN perf_script_output TEXT NOT NULL DEFAULT ''`);
  migrateRunStepPerfUniqueConstraint(db);

  // Add cmdline column to host_snap_proc_pid_stat (idempotent)
  const pidStatCols = (db.prepare(`PRAGMA table_info(host_snap_proc_pid_stat)`).all() as { name: string }[]).map(c => c.name);
  if (pidStatCols.length > 0 && !pidStatCols.includes('cmdline')) {
    db.exec(`ALTER TABLE host_snap_proc_pid_stat ADD COLUMN cmdline TEXT DEFAULT ''`);
  }

  // Add VPC / private-host columns (idempotent)
  const pgServerCols2 = (db.prepare(`PRAGMA table_info(pg_servers)`).all() as { name: string }[]).map(c => c.name);
  if (!pgServerCols2.includes('private_host')) db.exec(`ALTER TABLE pg_servers ADD COLUMN private_host TEXT NOT NULL DEFAULT ''`);
  if (!pgServerCols2.includes('vpc')) db.exec(`ALTER TABLE pg_servers ADD COLUMN vpc TEXT NOT NULL DEFAULT ''`);
  if (!pgServerCols2.includes('perf_enabled')) db.exec(`ALTER TABLE pg_servers ADD COLUMN perf_enabled INTEGER NOT NULL DEFAULT 0`);
  if (!pgServerCols2.includes('perf_scope')) db.exec(`ALTER TABLE pg_servers ADD COLUMN perf_scope TEXT NOT NULL DEFAULT 'disabled'`);
  if (!pgServerCols2.includes('perf_cgroup')) db.exec(`ALTER TABLE pg_servers ADD COLUMN perf_cgroup TEXT NOT NULL DEFAULT ''`);
  if (!pgServerCols2.includes('perf_events')) db.exec(`ALTER TABLE pg_servers ADD COLUMN perf_events TEXT NOT NULL DEFAULT 'task-clock,cpu-clock,context-switches,cpu-migrations,page-faults,minor-faults,major-faults'`);
  if (!pgServerCols2.includes('perf_status_json')) db.exec(`ALTER TABLE pg_servers ADD COLUMN perf_status_json TEXT NOT NULL DEFAULT ''`);
  db.prepare(`UPDATE pg_servers SET perf_events = ? WHERE perf_events = '' OR perf_events = ?`).run(DEFAULT_PERF_EVENTS, OLD_DEFAULT_PERF_EVENTS);

  const ec2ServerCols = (db.prepare(`PRAGMA table_info(ec2_servers)`).all() as { name: string }[]).map(c => c.name);
  if (!ec2ServerCols.includes('vpc')) db.exec(`ALTER TABLE ec2_servers ADD COLUMN vpc TEXT NOT NULL DEFAULT ''`);
  if (!ec2ServerCols.includes('cli_log_dir')) db.exec(`ALTER TABLE ec2_servers ADD COLUMN cli_log_dir TEXT NOT NULL DEFAULT '/tmp/gocli-logs'`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_series (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id      INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      name           TEXT    NOT NULL DEFAULT '',
      delay_seconds  INTEGER NOT NULL DEFAULT 0,
      status         TEXT    NOT NULL DEFAULT 'running',
      ec2_run_token  TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS decision_suites (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id    INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      name           TEXT    NOT NULL DEFAULT '',
      status         TEXT    NOT NULL DEFAULT 'running',
      ec2_run_token  TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT
    );
  `);

  // Add cli_log column for persisting Go CLI stderr (warnings, errors) downloaded after each run
  const runColsCliLog = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
  if (!runColsCliLog.includes('cli_log')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN cli_log TEXT NOT NULL DEFAULT ''`);
  const seriesColsCliLog = (db.prepare(`PRAGMA table_info(benchmark_series)`).all() as { name: string }[]).map(c => c.name);
  if (!seriesColsCliLog.includes('cli_log')) db.exec(`ALTER TABLE benchmark_series ADD COLUMN cli_log TEXT NOT NULL DEFAULT ''`);
  const suiteColsCliLog = (db.prepare(`PRAGMA table_info(decision_suites)`).all() as { name: string }[]).map(c => c.name);
  if (!suiteColsCliLog.includes('cli_log')) db.exec(`ALTER TABLE decision_suites ADD COLUMN cli_log TEXT NOT NULL DEFAULT ''`);

  // Add exec_log_path for tail-based SSE streaming (the VPS path of the exec log written by Go CLI)
  const runColsExecLog = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
  if (!runColsExecLog.includes('exec_log_path')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN exec_log_path TEXT NOT NULL DEFAULT ''`);
  const seriesColsExecLog = (db.prepare(`PRAGMA table_info(benchmark_series)`).all() as { name: string }[]).map(c => c.name);
  if (!seriesColsExecLog.includes('exec_log_path')) db.exec(`ALTER TABLE benchmark_series ADD COLUMN exec_log_path TEXT NOT NULL DEFAULT ''`);
  const suiteColsExecLog = (db.prepare(`PRAGMA table_info(decision_suites)`).all() as { name: string }[]).map(c => c.name);
  if (!suiteColsExecLog.includes('exec_log_path')) db.exec(`ALTER TABLE decision_suites ADD COLUMN exec_log_path TEXT NOT NULL DEFAULT ''`);

  // Add output_file to run_step_results to store per-step log file path emitted in step_start events
  const stepResultColsOutputFile = (db.prepare(`PRAGMA table_info(run_step_results)`).all() as { name: string }[]).map(c => c.name);
  if (!stepResultColsOutputFile.includes('output_file')) db.exec(`ALTER TABLE run_step_results ADD COLUMN output_file TEXT NOT NULL DEFAULT ''`);

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

	// Migration: drop and recreate all supported snap tables
	const snapMigrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = 'snap_pg16_v1'`).get();
	if (!snapMigrated) {
		db.exec(`
      DROP TABLE IF EXISTS snap_pg_stat_database;
      DROP TABLE IF EXISTS snap_pg_stat_bgwriter;
      DROP TABLE IF EXISTS snap_pg_stat_checkpointer;
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
      ${createSupportedSnapTablesSql('_is_baseline INTEGER NOT NULL DEFAULT 0')}

      INSERT INTO schema_migrations (id) VALUES ('snap_pg16_v1');
    `);
	}

	// Migration: replace _is_baseline with _phase on all snap tables; re-seed metrics
	const snapPhaseMigrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = 'snap_phase_v1'`).get();
	if (!snapPhaseMigrated) {
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
      DROP TABLE IF EXISTS snap_pg_stat_checkpointer;
      ${createSupportedSnapTablesSql()}

      INSERT INTO schema_migrations (id) VALUES ('snap_phase_v1');
    `);
	}

	// Idempotent column additions for existing DBs
	// Add duration_secs to design_steps (idempotent)
	const stepCols = (db.prepare(`PRAGMA table_info(design_steps)`).all() as { name: string }[]).map(c => c.name);
	if (!stepCols.includes('duration_secs')) db.exec(`ALTER TABLE design_steps ADD COLUMN duration_secs INTEGER NOT NULL DEFAULT 0`);
	if (!stepCols.includes('no_transaction')) db.exec(`ALTER TABLE design_steps ADD COLUMN no_transaction INTEGER NOT NULL DEFAULT 0`);
	if (!stepCols.includes('collect_perf')) db.exec(`ALTER TABLE design_steps ADD COLUMN collect_perf INTEGER NOT NULL DEFAULT 0`);
	if (!stepCols.includes('perf_duration')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_duration TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_stat_duration')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_stat_duration TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_record_duration')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_record_duration TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_trace_duration')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_trace_duration TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_stat_enabled')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_stat_enabled INTEGER NOT NULL DEFAULT 0`);
	if (!stepCols.includes('perf_record_enabled')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_record_enabled INTEGER NOT NULL DEFAULT 0`);
	if (!stepCols.includes('perf_trace_enabled')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_trace_enabled INTEGER NOT NULL DEFAULT 0`);
	if (!stepCols.includes('perf_delay')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_delay TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_stat_delay')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_stat_delay TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_record_delay')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_record_delay TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_trace_delay')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_trace_delay TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_mode')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_mode TEXT NOT NULL DEFAULT 'stat'`);
	if (!stepCols.includes('perf_cgroup')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_cgroup TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_events')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_events TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_repeat')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_repeat TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_freq')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_freq TEXT NOT NULL DEFAULT ''`);
	if (!stepCols.includes('perf_call_graph')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_call_graph TEXT NOT NULL DEFAULT 'dwarf'`);
	if (!stepCols.includes('perf_mmap_pages')) db.exec(`ALTER TABLE design_steps ADD COLUMN perf_mmap_pages TEXT NOT NULL DEFAULT ''`);
	const perfModeToggleMigrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = 'perf_mode_toggles_v1'`).get();
	if (!perfModeToggleMigrated) {
		db.exec(`
      UPDATE design_steps SET perf_stat_enabled = 1 WHERE type = 'perf' AND perf_mode = 'stat';
      UPDATE design_steps SET perf_record_enabled = 1 WHERE type = 'perf' AND perf_mode = 'record';
      UPDATE design_steps SET perf_trace_enabled = 1 WHERE type = 'perf' AND perf_mode = 'trace';
    `);
		db.prepare(`INSERT INTO schema_migrations (id) VALUES ('perf_mode_toggles_v1')`).run();
	}

	db.exec(createSnapPgStatStatementsTableSql().replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
	const pgStatStatementsMigrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = 'snap_pg_stat_statements_v2'`).get();
	if (!pgStatStatementsMigrated) {
		db.exec(`
      DROP TABLE IF EXISTS snap_pg_stat_statements;
    `);
		db.exec(createSnapPgStatStatementsTableSql());
		db.prepare(`INSERT INTO schema_migrations (id) VALUES ('snap_pg_stat_statements_v2')`).run();
	}
	migrateBgwriterAndCheckpointerTables(db);
	migratePg18WalAndIoTables(db);
	const snapPg18ResetMigrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = 'snap_pg18_reset_v1'`).get();
	if (!snapPg18ResetMigrated) {
		resetSupportedPg18SnapTables(db);
		db.exec(`DROP TABLE IF EXISTS snap_pg_stat_statements`);
		db.exec(createSnapPgStatStatementsTableSql());
		db.prepare(`INSERT INTO schema_migrations (id) VALUES ('snap_pg18_reset_v1')`).run();
	}
	migratePgLocksWaitstartColumn(db);

	const designCols = (db.prepare(`PRAGMA table_info(designs)`).all() as { name: string }[]).map(c => c.name);
	if (!designCols.includes('pre_collect_secs')) db.exec(`ALTER TABLE designs ADD COLUMN pre_collect_secs INTEGER NOT NULL DEFAULT 0`);
	if (!designCols.includes('post_collect_secs')) db.exec(`ALTER TABLE designs ADD COLUMN post_collect_secs INTEGER NOT NULL DEFAULT 60`);
	if (!designCols.includes('snapshot_interval_seconds')) db.exec(`ALTER TABLE designs ADD COLUMN snapshot_interval_seconds INTEGER NOT NULL DEFAULT 30`);

	const runCols = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
	if (!runCols.includes('pre_collect_secs')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN pre_collect_secs INTEGER NOT NULL DEFAULT 0`);
	if (!runCols.includes('post_collect_secs')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN post_collect_secs INTEGER NOT NULL DEFAULT 60`);
	if (!runCols.includes('bench_started_at')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN bench_started_at TEXT`);
	if (!runCols.includes('post_started_at')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN post_started_at TEXT`);
	if (!runCols.includes('name')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
	if (!runCols.includes('notes')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);
	if (!runCols.includes('profile_name')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN profile_name TEXT NOT NULL DEFAULT ''`);
	if (!runCols.includes('run_params')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN run_params TEXT NOT NULL DEFAULT ''`);
	if (!runCols.includes('database')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN database TEXT NOT NULL DEFAULT ''`);
	if (!runCols.includes('is_imported')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 0`);
	if (!runCols.includes('ec2_server_id')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN ec2_server_id INTEGER REFERENCES ec2_servers(id)`);
	if (!runCols.includes('ec2_run_token')) db.exec(`ALTER TABLE benchmark_runs ADD COLUMN ec2_run_token TEXT`);
	db.exec(`
    UPDATE benchmark_runs
    SET database = COALESCE(NULLIF(database, ''), (
      SELECT designs.database FROM designs WHERE designs.id = benchmark_runs.design_id
    ), '')
    WHERE database = ''
  `);

	// ec2_servers: migrate key_path → private_key (stores key content instead of path)
	const ec2Cols = (db.prepare(`PRAGMA table_info(ec2_servers)`).all() as { name: string }[]).map(c => c.name);
	if (ec2Cols.includes('key_path') && !ec2Cols.includes('private_key')) {
		db.exec(`ALTER TABLE ec2_servers ADD COLUMN private_key TEXT NOT NULL DEFAULT ''`);
	}

	// Per-decision metrics (compare screen, persisted)
	db.exec(`
    CREATE TABLE IF NOT EXISTS decision_metrics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      category    TEXT    NOT NULL DEFAULT 'Custom',
      description TEXT    NOT NULL DEFAULT '',
      sql         TEXT    NOT NULL,
      higher_is_better INTEGER NOT NULL DEFAULT 1,
      position    INTEGER NOT NULL DEFAULT 0,
      time_col    TEXT    NOT NULL DEFAULT '',
      value_col   TEXT    NOT NULL DEFAULT ''
    );
  `);
  const dmCols = (db.prepare(`PRAGMA table_info(decision_metrics)`).all() as { name: string }[]).map(c => c.name);
  if (!dmCols.includes('time_col')) db.exec(`ALTER TABLE decision_metrics ADD COLUMN time_col TEXT NOT NULL DEFAULT ''`);
  if (!dmCols.includes('value_col')) db.exec(`ALTER TABLE decision_metrics ADD COLUMN value_col TEXT NOT NULL DEFAULT ''`);


	// Raw pg_locks snapshots (simpler than conflict pairs — tree analysis done in UI)
	db.exec(createSnapPgLocksTableSql().replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));



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
				'BGWriter stats',
				`SELECT buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
FROM snap_pg_stat_bgwriter WHERE _run_id = ? ORDER BY _collected_at DESC LIMIT 1`
			);
		});
		seedMany();
	}

	migrateBgwriterQueriesAndMetrics(db);
	backfillPgStatCheckpointerSelections(db);

	// SSH columns on pg_servers for OS metrics collection
	const pgServerSshMigrated = db.prepare(`SELECT id FROM schema_migrations WHERE id = 'pg_server_ssh_v1'`).get();
	if (!pgServerSshMigrated) {
		const pgServerCols = (db.pragma(`table_info(pg_servers)`) as { name: string }[]).map((c) => c.name);
		if (!pgServerCols.includes('ssh_enabled')) {
			db.exec(`ALTER TABLE pg_servers ADD COLUMN ssh_enabled INTEGER NOT NULL DEFAULT 0`);
		}
		if (!pgServerCols.includes('ssh_host')) {
			db.exec(`ALTER TABLE pg_servers ADD COLUMN ssh_host TEXT`);
		}
		if (!pgServerCols.includes('ssh_port')) {
			db.exec(`ALTER TABLE pg_servers ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22`);
		}
		if (!pgServerCols.includes('ssh_user')) {
			db.exec(`ALTER TABLE pg_servers ADD COLUMN ssh_user TEXT`);
		}
		if (!pgServerCols.includes('ssh_private_key')) {
			db.exec(`ALTER TABLE pg_servers ADD COLUMN ssh_private_key TEXT`);
		}
		db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run('pg_server_ssh_v1');
	}

	// weight_expr on pgbench_scripts (allows {{PARAM}} expressions for weights)
	const scriptCols = (db.prepare(`PRAGMA table_info(pgbench_scripts)`).all() as { name: string }[]).map(c => c.name);
	if (!scriptCols.includes('weight_expr')) {
		db.exec(`ALTER TABLE pgbench_scripts ADD COLUMN weight_expr TEXT DEFAULT NULL`);
	}

	// host_config column on benchmark_runs (one-time OS/PG config snapshot as JSON)
	const runColsHost = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
	if (!runColsHost.includes('host_config')) {
		db.exec(`ALTER TABLE benchmark_runs ADD COLUMN host_config TEXT`);
	}

	// host_snap_* timeseries tables — base schemas; data columns added dynamically by importer
	db.exec(`
    CREATE TABLE IF NOT EXISTS host_snap_vmstat (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_loadavg (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_meminfo (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_stat (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_vmstat (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_psi (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_schedstat (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      cpu_id TEXT
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_diskstats (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      device TEXT
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_netdev (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      iface TEXT
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_sys_fs_file_nr (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_pid_stat (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      pid INTEGER,
      comm TEXT,
      state TEXT,
      cmdline TEXT
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_pid_statm (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      pid INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_pid_io (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      pid INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_pid_status (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      pid INTEGER,
      name TEXT,
      state TEXT
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_pid_schedstat (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      pid INTEGER
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_pid_wchan (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      pid INTEGER,
      wchan TEXT
    );
    CREATE TABLE IF NOT EXISTS host_snap_proc_pid_fd_count (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      pid INTEGER
    );
  `);

	// benchmark_series table + series_id on benchmark_runs
	db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_series (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id      INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      name           TEXT    NOT NULL DEFAULT '',
      delay_seconds  INTEGER NOT NULL DEFAULT 0,
      status         TEXT    NOT NULL DEFAULT 'running',
      ec2_run_token  TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT
    );
  `);
	const runCols2 = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
	if (!runCols2.includes('series_id')) {
		db.exec(`ALTER TABLE benchmark_runs ADD COLUMN series_id INTEGER REFERENCES benchmark_series(id)`);
	}

	// decision_suites table + suite_id on benchmark_series
	db.exec(`
    CREATE TABLE IF NOT EXISTS decision_suites (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id    INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      name           TEXT    NOT NULL DEFAULT '',
      status         TEXT    NOT NULL DEFAULT 'running',
      ec2_run_token  TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT
    );
  `);
	const seriesCols = (db.prepare(`PRAGMA table_info(benchmark_series)`).all() as { name: string }[]).map(c => c.name);
	if (!seriesCols.includes('suite_id')) {
		db.exec(`ALTER TABLE benchmark_series ADD COLUMN suite_id INTEGER REFERENCES decision_suites(id)`);
	}

	// decision-level shared params and profiles
	db.exec(`
    CREATE TABLE IF NOT EXISTS decision_params (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      name        TEXT    NOT NULL DEFAULT '',
      value       TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS decision_param_profiles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS decision_param_profile_values (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES decision_param_profiles(id) ON DELETE CASCADE,
      param_name TEXT    NOT NULL DEFAULT '',
      value      TEXT    NOT NULL DEFAULT ''
    );
  `);
}

export default getDb;
