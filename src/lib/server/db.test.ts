import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadDbModule(dataDir: string) {
	process.env.DATA_DIR = dataDir;
	vi.resetModules();
	return await import('./db');
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
    CREATE TABLE snap_pg_stat_bgwriter (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
      _collected_at TEXT NOT NULL,
      _phase TEXT NOT NULL DEFAULT 'bench',
      checkpoints_timed INTEGER,
      checkpoints_req INTEGER,
      checkpoint_write_time REAL,
      checkpoint_sync_time REAL,
      buffers_checkpoint INTEGER,
      buffers_clean INTEGER,
      maxwritten_clean INTEGER,
      buffers_backend INTEGER,
      buffers_backend_fsync INTEGER,
      buffers_alloc INTEGER,
      stats_reset TEXT
    );
    INSERT INTO decisions (id, name) VALUES (1, 'decision');
    INSERT INTO designs (id, decision_id, name, database) VALUES (1, 1, 'design', 'legacy_db');
    INSERT INTO benchmark_runs (id, design_id, database) VALUES (1, 1, '');
    INSERT INTO snap_pg_stat_bgwriter (
      _run_id, _collected_at, _phase, checkpoints_timed, buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
    ) VALUES (
      1, '2026-03-30T06:00:00Z', 'bench', 4, 10, 2, 25, '2026-03-30T05:00:00Z'
    );
  `);
	db.close();
}

describe('db migration for bgwriter/checkpointer', () => {
	const originalDataDir = process.env.DATA_DIR;
	let dataDir = '';

	afterEach(() => {
		process.env.DATA_DIR = originalDataDir;
		if (dataDir) rmSync(dataDir, { recursive: true, force: true });
		dataDir = '';
	});

	it('rebuilds bgwriter schema, creates checkpointer table, and preserves overlapping data', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-db-test-'));
		const dbPath = join(dataDir, 'mybench.db');
		seedLegacyDb(dbPath);

		const dbModule = await loadDbModule(dataDir);
		const db = dbModule.getDb();

		const bgwriterCols = (db.prepare(`PRAGMA table_info(snap_pg_stat_bgwriter)`).all() as { name: string }[])
			.map((col) => col.name);
		expect(bgwriterCols).toEqual([
			'_id',
			'_run_id',
			'_collected_at',
			'_phase',
			'buffers_clean',
			'maxwritten_clean',
			'buffers_alloc',
			'stats_reset'
		]);

		const checkpointerCols = (db.prepare(`PRAGMA table_info(snap_pg_stat_checkpointer)`).all() as { name: string }[])
			.map((col) => col.name);
		expect(checkpointerCols).toEqual([
			'_id',
			'_run_id',
			'_collected_at',
			'_phase',
			'num_timed',
			'num_requested',
			'restartpoints_timed',
			'restartpoints_req',
			'restartpoints_done',
			'write_time',
			'sync_time',
			'buffers_written',
			'stats_reset'
		]);

		const rows = db.prepare(`
      SELECT _run_id, _collected_at, _phase, buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
      FROM snap_pg_stat_bgwriter
    `).all() as {
			_run_id: number;
			_collected_at: string;
			_phase: string;
			buffers_clean: number;
			maxwritten_clean: number;
			buffers_alloc: number;
			stats_reset: string;
		}[];
		expect(rows).toEqual([
			{
				_run_id: 1,
				_collected_at: '2026-03-30T06:00:00Z',
				_phase: 'bench',
				buffers_clean: 10,
				maxwritten_clean: 2,
				buffers_alloc: 25,
				stats_reset: '2026-03-30T05:00:00Z'
			}
		]);

		db.close();
	});

	it('is idempotent when reopening the same database', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-db-test-'));
		const dbPath = join(dataDir, 'mybench.db');
		seedLegacyDb(dbPath);

		let dbModule = await loadDbModule(dataDir);
		let db = dbModule.getDb();
		db.close();

		dbModule = await loadDbModule(dataDir);
		db = dbModule.getDb();

		const migrationCount = db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'snap_bgwriter_checkpointer_v1'
    `).get() as { count: number };
		const rowCount = db.prepare(`SELECT COUNT(*) AS count FROM snap_pg_stat_bgwriter`).get() as { count: number };

		expect(migrationCount.count).toBe(1);
		expect(rowCount.count).toBe(1);
		db.close();
	});
});
