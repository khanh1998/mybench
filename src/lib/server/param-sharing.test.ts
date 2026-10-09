import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

let dataDir = '';
let db: Database.Database;
let sharing: typeof import('./param-sharing');
let decisionId = 0;
let designA = 0;
let designB = 0;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'mybench-sharing-test-'));
	process.env.DATA_DIR = dataDir;
	vi.resetModules();
	db = (await import('./db')).getDb();
	sharing = await import('./param-sharing');
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
});

const decisionParams = () => db.prepare('SELECT name, value FROM decision_params WHERE decision_id = ?').all(decisionId);
const designParams = (id: number) => db.prepare('SELECT name, value FROM design_params WHERE design_id = ?').all(id);
const addLocal = (id: number, name: string, value: string) =>
	db.prepare('INSERT INTO design_params (design_id, position, name, value) VALUES (?, 0, ?, ?)').run(id, name, value);

describe('shareParam / unshareParam', () => {
	it('moves a local param to the decision and keeps sibling overrides by default', () => {
		addLocal(designA, 'CLIENTS', '8');
		addLocal(designB, 'CLIENTS', '64');
		sharing.shareParam(designA, 'CLIENTS', '8');
		expect(decisionParams()).toEqual([{ name: 'CLIENTS', value: '8' }]);
		expect(designParams(designA)).toEqual([]);
		expect(designParams(designB)).toEqual([{ name: 'CLIENTS', value: '64' }]);
	});

	it('can remove sibling overrides when sharing', () => {
		addLocal(designB, 'CLIENTS', '64');
		sharing.shareParam(designA, 'CLIENTS', '8', true);
		expect(designParams(designB)).toEqual([]);
	});

	it('unshare gives this design a local copy and leaves sibling overrides alone', () => {
		db.prepare(`INSERT INTO decision_params (decision_id, position, name, value) VALUES (?, 0, 'T', 'items')`).run(decisionId);
		addLocal(designB, 'T', 'other');
		sharing.unshareParam(designA, 'T');
		expect(decisionParams()).toEqual([]);
		expect(designParams(designA)).toEqual([{ name: 'T', value: 'items' }]);
		expect(designParams(designB)).toEqual([{ name: 'T', value: 'other' }]);
	});

	it('unshare keeps an existing override as the local value', () => {
		db.prepare(`INSERT INTO decision_params (decision_id, position, name, value) VALUES (?, 0, 'T', 'items')`).run(decisionId);
		addLocal(designA, 'T', 'mine');
		sharing.unshareParam(designA, 'T');
		expect(designParams(designA)).toEqual([{ name: 'T', value: 'mine' }]);
	});
});

describe('shareProfile / unshareProfile', () => {
	const addLocalProfile = (id: number, name: string) => {
		const pid = db.prepare('INSERT INTO design_param_profiles (design_id, name) VALUES (?, ?)').run(id, name).lastInsertRowid as number;
		db.prepare(`INSERT INTO design_param_profile_values (profile_id, param_name, value) VALUES (?, 'CLIENTS', '64')`).run(pid);
		return pid;
	};

	it('round-trips a profile with its values', () => {
		const pid = addLocalProfile(designA, 'large');
		const sharedId = sharing.shareProfile(designA, pid);
		expect(db.prepare('SELECT COUNT(*) AS n FROM design_param_profiles').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT param_name, value FROM decision_param_profile_values WHERE profile_id = ?').all(sharedId))
			.toEqual([{ param_name: 'CLIENTS', value: '64' }]);

		const localId = sharing.unshareProfile(designB, sharedId);
		expect(db.prepare('SELECT COUNT(*) AS n FROM decision_param_profiles').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT design_id FROM design_param_profiles WHERE id = ?').get(localId)).toEqual({ design_id: designB });
	});

	it('refuses to share over a same-named sibling profile unless asked to remove it', () => {
		const pid = addLocalProfile(designA, 'large');
		addLocalProfile(designB, 'large');
		expect(() => sharing.shareProfile(designA, pid)).toThrow(/Other designs/);
		sharing.shareProfile(designA, pid, true);
		expect(db.prepare('SELECT COUNT(*) AS n FROM design_param_profiles').get()).toEqual({ n: 0 });
	});

	it('detects profile name conflicts across shared and local', () => {
		addLocalProfile(designB, 'large');
		expect(sharing.decisionProfileNameConflict(decisionId, 'large')).toMatch(/"B"/);
		db.prepare(`INSERT INTO decision_param_profiles (decision_id, name) VALUES (?, 'small')`).run(decisionId);
		expect(sharing.designProfileNameConflict(designA, 'small')).toMatch(/shared profile/);
		expect(sharing.designProfileNameConflict(designA, 'medium')).toBeNull();
	});
});

describe('getSiblingUsage', () => {
	it('reports sibling local params, profiles and referenced placeholders', () => {
		addLocal(designB, 'FILL', '90');
		db.prepare(`INSERT INTO design_steps (design_id, position, name, type, script) VALUES (?, 0, 's', 'sql', 'CREATE TABLE {{TABLE}} WITH (fillfactor={{FILL}})')`).run(designB);
		const [b] = sharing.getSiblingUsage(designA);
		expect(b.design_name).toBe('B');
		expect(b.local_params).toEqual([{ name: 'FILL', value: '90' }]);
		expect(b.referenced.sort()).toEqual(['FILL', 'TABLE']);
	});
});
