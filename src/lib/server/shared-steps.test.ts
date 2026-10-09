import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

let dataDir = '';
let db: Database.Database;
let ss: typeof import('./shared-steps');
let decisionId = 0;
let designA = 0;
let designB = 0;
let designC = 0;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'mybench-shared-steps-test-'));
	process.env.DATA_DIR = dataDir;
	vi.resetModules();
	db = (await import('./db')).getDb();
	ss = await import('./shared-steps');
});

afterAll(() => {
	db?.close();
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
	db.exec('DELETE FROM decisions');
	decisionId = db.prepare(`INSERT INTO decisions (name) VALUES ('d')`).run().lastInsertRowid as number;
	designA = db.prepare(`INSERT INTO designs (decision_id, name) VALUES (?, 'A')`).run(decisionId).lastInsertRowid as number;
	designB = db.prepare(`INSERT INTO designs (decision_id, name) VALUES (?, 'B')`).run(decisionId).lastInsertRowid as number;
	const other = db.prepare(`INSERT INTO decisions (name) VALUES ('other')`).run().lastInsertRowid as number;
	designC = db.prepare(`INSERT INTO designs (decision_id, name) VALUES (?, 'C')`).run(other).lastInsertRowid as number;
});

function addStep(designId: number, position: number, name: string, type = 'sql', script = '') {
	return db.prepare('INSERT INTO design_steps (design_id, position, name, type, script) VALUES (?, ?, ?, ?, ?)')
		.run(designId, position, name, type, script).lastInsertRowid as number;
}
const step = (id: number) => db.prepare('SELECT * FROM design_steps WHERE id = ?').get(id) as Record<string, unknown>;
const stepsOf = (designId: number) =>
	db.prepare('SELECT id, name, position, shared_step_id FROM design_steps WHERE design_id = ? ORDER BY position').all(designId) as { id: number; name: string; position: number; shared_step_id: number | null }[];

describe('shared steps', () => {
	it('links a shared step into another design as a full copy at the requested position', () => {
		const pgbench = addStep(designA, 0, 'bench', 'pgbench');
		db.prepare(`INSERT INTO pgbench_scripts (step_id, position, name, weight, script) VALUES (?, 0, 'read', 70, 'SELECT 1')`).run(pgbench);
		addStep(designB, 0, 'setup');
		addStep(designB, 1, 'teardown');

		const sharedId = ss.shareStep(pgbench);
		const linked = ss.linkSharedStep(designB, sharedId, 1);

		expect(stepsOf(designB).map(s => s.name)).toEqual(['setup', 'bench', 'teardown']);
		expect(step(linked)).toMatchObject({ type: 'pgbench', shared_step_id: sharedId, enabled: 1 });
		expect(db.prepare('SELECT name, weight, script FROM pgbench_scripts WHERE step_id = ?').all(linked))
			.toEqual([{ name: 'read', weight: 70, script: 'SELECT 1' }]);
	});

	it('syncs content but not position/enabled to linked rows', () => {
		const a = addStep(designA, 0, 'pg_stat', 'pg_stat');
		const sharedId = ss.shareStep(a);
		const b = ss.linkSharedStep(designB, sharedId);
		db.prepare('UPDATE design_steps SET enabled = 0 WHERE id = ?').run(b);

		db.prepare(`UPDATE design_steps SET name = 'stats', pg_stat_tables = '["pg_stat_io"]', position = 5 WHERE id = ?`).run(a);
		expect(ss.syncSharedStep(a)).toEqual([b]);
		expect(step(b)).toMatchObject({ name: 'stats', pg_stat_tables: '["pg_stat_io"]', position: 0, enabled: 0 });
	});

	it('refuses to link across decisions', () => {
		const sharedId = ss.shareStep(addStep(designA, 0, 's'));
		expect(() => ss.linkSharedStep(designC, sharedId)).toThrow(/different decision/);
	});

	it('detach keeps the copy and removes the group once nobody uses it', () => {
		const a = addStep(designA, 0, 's', 'sql', 'SELECT 1');
		const sharedId = ss.shareStep(a);
		const b = ss.linkSharedStep(designB, sharedId);

		ss.detachStep(b);
		expect(step(b)).toMatchObject({ shared_step_id: null, script: 'SELECT 1' });
		expect(ss.listSharedSteps(decisionId)).toHaveLength(1);

		ss.detachStep(a);
		expect(ss.listSharedSteps(decisionId)).toEqual([]);
		expect(db.prepare('SELECT COUNT(*) AS n FROM shared_steps').get()).toEqual({ n: 0 });
	});

	it('unshare leaves every design with its own copy and keeps step ids', () => {
		const a = addStep(designA, 0, 's', 'sql', 'SELECT 1');
		const sharedId = ss.shareStep(a);
		const b = ss.linkSharedStep(designB, sharedId);

		const unlinked = ss.unshareStep(sharedId);
		expect(unlinked.map(u => u.design_name)).toEqual(['A', 'B']);
		expect(step(a)).toMatchObject({ id: a, shared_step_id: null, script: 'SELECT 1' });
		expect(step(b)).toMatchObject({ id: b, shared_step_id: null, script: 'SELECT 1' });
	});

	it('lists shared steps with their designs and drops groups whose designs were deleted', () => {
		const sharedId = ss.shareStep(addStep(designA, 0, 'stats', 'pg_stat'));
		const b = ss.linkSharedStep(designB, sharedId);
		expect(ss.listSharedSteps(decisionId)).toEqual([{
			id: sharedId, name: 'stats', type: 'pg_stat',
			designs: [
				{ design_id: designA, design_name: 'A', step_id: expect.any(Number) },
				{ design_id: designB, design_name: 'B', step_id: b }
			]
		}]);
		expect(ss.sharedWith(b)).toEqual([{ design_id: designA, design_name: 'A' }]);

		db.prepare('DELETE FROM designs WHERE id IN (?, ?)').run(designA, designB);
		expect(ss.listSharedSteps(decisionId)).toEqual([]);
	});

	it('content columns exclude per-design fields', () => {
		const cols = ss.stepContentColumns();
		for (const c of ['id', 'design_id', 'position', 'enabled', 'shared_step_id']) expect(cols).not.toContain(c);
		for (const c of ['name', 'type', 'script', 'pg_stat_tables', 'proc_groups', 'perf_events']) expect(cols).toContain(c);
	});
});
