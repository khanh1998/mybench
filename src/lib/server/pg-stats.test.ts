import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MockQueryResult = {
	rows: Record<string, unknown>[];
	fields: Array<{ name: string }>;
};

async function loadModules(dataDir: string) {
	process.env.DATA_DIR = dataDir;
	vi.resetModules();
	const dbModule = await import('./db');
	const pgStatsModule = await import('./pg-stats');
	return { dbModule, pgStatsModule };
}

describe('pg-stats snapshot collection', () => {
	const originalDataDir = process.env.DATA_DIR;
	let dataDir = '';

	afterEach(() => {
		process.env.DATA_DIR = originalDataDir;
		vi.restoreAllMocks();
		if (dataDir) rmSync(dataDir, { recursive: true, force: true });
		dataDir = '';
	});

	it('does not mutate a drifted snapshot table at collection time', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-pg-stats-test-'));
		const { dbModule, pgStatsModule } = await loadModules(dataDir);
		const db = dbModule.getDb();

		db.exec(`
      DROP TABLE snap_pg_stat_subscription;
      CREATE TABLE snap_pg_stat_subscription (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        _run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        _collected_at TEXT NOT NULL,
        _phase TEXT NOT NULL DEFAULT 'bench',
        subid INTEGER,
        subname TEXT,
        pid INTEGER,
        leader_pid INTEGER,
        relid INTEGER,
        received_lsn TEXT,
        last_msg_send_time TEXT,
        last_msg_receipt_time TEXT,
        latest_end_lsn TEXT,
        latest_end_time TEXT
      );
    `);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const result: MockQueryResult = {
			rows: [{
				subid: 1,
				subname: 'sub',
				worker_type: 'apply',
				pid: 42,
				leader_pid: null,
				relid: 7,
				received_lsn: '0/16B6A80',
				last_msg_send_time: '2026-03-31T00:00:00Z',
				last_msg_receipt_time: '2026-03-31T00:00:01Z',
				latest_end_lsn: '0/16B6AF0',
				latest_end_time: '2026-03-31T00:00:02Z'
			}],
			fields: [
				{name: 'subid'},
				{name: 'subname'},
				{name: 'worker_type'},
				{name: 'pid'},
				{name: 'leader_pid'},
				{name: 'relid'},
				{name: 'received_lsn'},
				{name: 'last_msg_send_time'},
				{name: 'last_msg_receipt_time'},
				{name: 'latest_end_lsn'},
				{name: 'latest_end_time'}
			]
		};
		const pgPool = {
			query: vi.fn(async () => result)
		};

		await pgStatsModule.collectSnapshot(pgPool as never, 1, ['pg_stat_subscription'], 'bench');

		const cols = (db.prepare(`PRAGMA table_info(snap_pg_stat_subscription)`).all() as { name: string }[])
			.map((col) => col.name);
		expect(cols).not.toContain('worker_type');

		const rowCount = db.prepare(`SELECT COUNT(*) AS count FROM snap_pg_stat_subscription`).get() as { count: number };
		expect(rowCount.count).toBe(0);
		expect(warnSpy).toHaveBeenCalledWith(
			'Skipping snap_pg_stat_subscription snapshot:',
			expect.stringContaining('snapshot schema mismatch')
		);

		db.close();
	});
});
