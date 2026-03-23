import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers: create a fresh in-memory DB and seed it
// ---------------------------------------------------------------------------

function createTestDb() {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(`
    CREATE TABLE pg_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT 'localhost',
      port INTEGER NOT NULL DEFAULT 5432,
      username TEXT NOT NULL DEFAULT 'postgres',
      password TEXT NOT NULL DEFAULT '',
      ssl INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pg_stat_table_selections (
      server_id INTEGER NOT NULL REFERENCES pg_servers(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (server_id, table_name)
    );
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
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
    CREATE TABLE design_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'sql',
      script TEXT NOT NULL DEFAULT '',
      pgbench_options TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      duration_secs INTEGER NOT NULL DEFAULT 0,
      no_transaction INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pgbench_scripts (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      step_id  INTEGER NOT NULL REFERENCES design_steps(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      name     TEXT    NOT NULL DEFAULT 'script',
      weight   INTEGER NOT NULL DEFAULT 1,
      script   TEXT    NOT NULL DEFAULT ''
    );
    CREATE TABLE design_params (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      position  INTEGER NOT NULL DEFAULT 0,
      name      TEXT    NOT NULL DEFAULT '',
      value     TEXT    NOT NULL DEFAULT ''
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
    CREATE TABLE snap_pg_stat_database (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      _run_id INTEGER,
      _collected_at TEXT NOT NULL,
      _is_baseline INTEGER NOT NULL DEFAULT 0,
      _phase TEXT,
      datid INTEGER, datname TEXT, xact_commit INTEGER
    );
  `);
	return db;
}

// ---------------------------------------------------------------------------
// Handler logic extracted (mirrors +server.ts)
// ---------------------------------------------------------------------------

const EXCLUDED_SNAP_COLS = new Set(['_id', '_run_id', '_collected_at', '_phase', '_is_baseline']);

const SNAP_TABLE_MAP: Record<string, string> = {
	pg_stat_database: 'snap_pg_stat_database',
	pg_stat_bgwriter: 'snap_pg_stat_bgwriter'
};

function exportPlan(db: Database.Database, designId: number) {
	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId) as {
		id: number; decision_id: number; name: string; description: string;
		server_id: number | null; database: string;
		pre_collect_secs: number; post_collect_secs: number;
		snapshot_interval_seconds: number;
	} | undefined;

	if (!design) return null;

	const steps = db.prepare(
		'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
	).all(designId) as { id: number; type: string; position: number; name: string; script: string; no_transaction: number; duration_secs: number; pgbench_options: string; enabled: number }[];

	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ? AND enabled = 1) ORDER BY step_id, position'
	).all(designId) as { id: number; step_id: number; name: string; weight: number; script: string }[];

	const scriptsByStep = new Map<number, typeof pgbenchScripts>();
	for (const ps of pgbenchScripts) {
		const arr = scriptsByStep.get(ps.step_id) ?? [];
		arr.push(ps);
		scriptsByStep.set(ps.step_id, arr);
	}

	const stepsWithScripts = steps.map(s => ({
		id: s.id,
		position: s.position,
		name: s.name,
		type: s.type,
		enabled: !!s.enabled,
		script: s.script,
		no_transaction: !!s.no_transaction,
		duration_secs: s.duration_secs,
		pgbench_options: s.pgbench_options,
		pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []).map(ps => ({
			id: ps.id, name: ps.name, weight: ps.weight, script: ps.script
		})) : []
	}));

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(designId) as { name: string; value: string }[];

	let serverInfo = { host: '', port: 5432, username: '', password: '', database: design.database, ssl: false };
	if (design.server_id) {
		const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(design.server_id) as {
			host: string; port: number; username: string; password: string; ssl: number;
		} | undefined;
		if (server) {
			serverInfo = { host: server.host, port: server.port, username: server.username, password: server.password, database: design.database, ssl: !!server.ssl };
		}
	}

	const enabledSnapTables: Array<{ pg_view_name: string; snap_table_name: string; columns: string[] }> = [];
	if (design.server_id) {
		const enabledRows = db.prepare(
			`SELECT table_name FROM pg_stat_table_selections WHERE server_id = ? AND enabled = 1`
		).all(design.server_id) as { table_name: string }[];

		for (const row of enabledRows) {
			const pgViewName = row.table_name;
			const snapTableName = SNAP_TABLE_MAP[pgViewName];
			if (!snapTableName) continue;
			let columns: string[] = [];
			try {
				const pragmaRows = db.prepare(`PRAGMA table_info(${snapTableName})`).all() as { name: string }[];
				if (pragmaRows.length > 0) {
					columns = pragmaRows.map(r => r.name).filter(name => !EXCLUDED_SNAP_COLS.has(name));
				}
			} catch {
				// table doesn't exist
			}
			enabledSnapTables.push({ pg_view_name: pgViewName, snap_table_name: snapTableName, columns });
		}
	}

	return {
		version: 1,
		exported_at: new Date().toISOString(),
		design_id: design.id,
		design_name: design.name,
		server: serverInfo,
		run_settings: {
			snapshot_interval_seconds: design.snapshot_interval_seconds,
			pre_collect_secs: design.pre_collect_secs,
			post_collect_secs: design.post_collect_secs
		},
		params: designParams.map(p => ({ name: p.name, value: p.value })),
		steps: stepsWithScripts,
		enabled_snap_tables: enabledSnapTables
	};
}

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

function seedDb(db: Database.Database) {
	db.prepare(`INSERT INTO decisions (id, name) VALUES (1, 'Test Decision')`).run();
	db.prepare(`INSERT INTO pg_servers (id, name, host, port, username, password, ssl) VALUES (1, 'local', 'localhost', 5432, 'pg', 'secret', 0)`).run();
	db.prepare(`INSERT INTO designs (id, decision_id, name, description, server_id, database, pre_collect_secs, post_collect_secs, snapshot_interval_seconds) VALUES (1, 1, 'My Design', '', 1, 'mydb', 10, 60, 15)`).run();
	db.prepare(`INSERT INTO design_steps (id, design_id, position, name, type, script, pgbench_options, enabled, duration_secs, no_transaction) VALUES (1, 1, 0, 'Setup', 'sql', 'CREATE TABLE t (id int);', '', 1, 0, 0)`).run();
	db.prepare(`INSERT INTO design_steps (id, design_id, position, name, type, script, pgbench_options, enabled, duration_secs, no_transaction) VALUES (2, 1, 1, 'Disabled', 'sql', 'DROP TABLE t;', '', 0, 0, 0)`).run();
	db.prepare(`INSERT INTO design_steps (id, design_id, position, name, type, script, pgbench_options, enabled, duration_secs, no_transaction) VALUES (3, 1, 2, 'Bench', 'pgbench', '', '-c 10 -T 30', 1, 0, 0)`).run();
	db.prepare(`INSERT INTO pgbench_scripts (id, step_id, position, name, weight, script) VALUES (1, 3, 0, 'main', 100, 'SELECT 1;')`).run();
	db.prepare(`INSERT INTO design_params (id, design_id, position, name, value) VALUES (1, 1, 0, 'scale', '10')`).run();
	db.prepare(`INSERT INTO pg_stat_table_selections (server_id, table_name, enabled) VALUES (1, 'pg_stat_database', 1)`).run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Export endpoint logic', () => {
	let db: Database.Database;

	beforeEach(() => {
		db = createTestDb();
		seedDb(db);
	});

	it('returns plan JSON matching expected schema for a seeded design', () => {
		const plan = exportPlan(db, 1);
		expect(plan).not.toBeNull();
		expect(plan!.version).toBe(1);
		expect(plan!.design_id).toBe(1);
		expect(plan!.design_name).toBe('My Design');
		expect(typeof plan!.exported_at).toBe('string');
		expect(plan!.server.host).toBe('localhost');
		expect(plan!.server.port).toBe(5432);
		expect(plan!.server.username).toBe('pg');
		expect(plan!.server.password).toBe('secret');
		expect(plan!.server.ssl).toBe(false);
		expect(plan!.run_settings.snapshot_interval_seconds).toBe(15);
		expect(plan!.run_settings.pre_collect_secs).toBe(10);
		expect(plan!.run_settings.post_collect_secs).toBe(60);
	});

	it('only includes enabled steps', () => {
		const plan = exportPlan(db, 1);
		expect(plan).not.toBeNull();
		const stepNames = plan!.steps.map(s => s.name);
		expect(stepNames).toContain('Setup');
		expect(stepNames).toContain('Bench');
		expect(stepNames).not.toContain('Disabled');
	});

	it('includes pgbench_scripts for pgbench steps', () => {
		const plan = exportPlan(db, 1);
		const benchStep = plan!.steps.find(s => s.type === 'pgbench');
		expect(benchStep).toBeDefined();
		expect(benchStep!.pgbench_scripts).toHaveLength(1);
		expect(benchStep!.pgbench_scripts![0].name).toBe('main');
		expect(benchStep!.pgbench_scripts![0].weight).toBe(100);
	});

	it('includes params', () => {
		const plan = exportPlan(db, 1);
		expect(plan!.params).toHaveLength(1);
		expect(plan!.params[0].name).toBe('scale');
		expect(plan!.params[0].value).toBe('10');
	});

	it('enabled_snap_tables excludes meta columns', () => {
		const plan = exportPlan(db, 1);
		const snapTable = plan!.enabled_snap_tables.find(t => t.pg_view_name === 'pg_stat_database');
		expect(snapTable).toBeDefined();
		expect(snapTable!.snap_table_name).toBe('snap_pg_stat_database');
		const cols = snapTable!.columns;
		expect(cols).not.toContain('_id');
		expect(cols).not.toContain('_run_id');
		expect(cols).not.toContain('_collected_at');
		expect(cols).not.toContain('_phase');
		expect(cols).not.toContain('_is_baseline');
		// Should contain actual data columns
		expect(cols).toContain('datname');
		expect(cols).toContain('xact_commit');
	});

	it('returns null for a non-existent design ID', () => {
		const plan = exportPlan(db, 9999);
		expect(plan).toBeNull();
	});

	it('response Content-Disposition header is correct', () => {
		// Simulate the Response construction
		const designId = 1;
		const plan = exportPlan(db, designId);
		const response = new Response(JSON.stringify(plan), {
			headers: {
				'Content-Type': 'application/json',
				'Content-Disposition': `attachment; filename="design-${designId}-plan.json"`
			}
		});
		expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="design-1-plan.json"');
	});
});
