import getDb from '$lib/server/db';
import { findPlaceholders } from '$lib/params';

/**
 * Moving params/profiles between design level (local) and decision level (shared).
 *
 * Resolution rules are unchanged: decision params are the shared defaults, design
 * params override them for single runs and series only; suites use decision-level
 * params/profiles exclusively.
 */

type Db = ReturnType<typeof getDb>;

export interface SiblingUsage {
	design_id: number;
	design_name: string;
	local_params: { name: string; value: string }[];
	local_profiles: string[];
	referenced: string[]; // {{NAME}} placeholders used anywhere in the design's steps
}

function decisionIdOf(db: Db, designId: number): number {
	const row = db.prepare('SELECT decision_id FROM designs WHERE id = ?').get(designId) as { decision_id: number } | undefined;
	if (!row) throw new Error(`Design ${designId} not found`);
	return row.decision_id;
}

/** Placeholders referenced by a design's steps (all text fields + pgbench scripts). */
export function referencedPlaceholders(designId: number): string[] {
	const db = getDb();
	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ?').all(designId);
	const scripts = db.prepare(
		'SELECT script, weight_expr FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?)'
	).all(designId);
	return [...new Set(findPlaceholders(JSON.stringify([steps, scripts])))];
}

/** How the other designs of the same decision use params/profiles — drives UI warnings. */
export function getSiblingUsage(designId: number): SiblingUsage[] {
	const db = getDb();
	const decisionId = decisionIdOf(db, designId);
	const designs = db.prepare('SELECT id, name FROM designs WHERE decision_id = ? AND id != ? ORDER BY id').all(decisionId, designId) as { id: number; name: string }[];
	const paramsStmt = db.prepare('SELECT name, value FROM design_params WHERE design_id = ? ORDER BY position');
	const profilesStmt = db.prepare('SELECT name FROM design_param_profiles WHERE design_id = ? ORDER BY id');
	return designs.map(d => ({
		design_id: d.id,
		design_name: d.name,
		local_params: paramsStmt.all(d.id) as { name: string; value: string }[],
		local_profiles: (profilesStmt.all(d.id) as { name: string }[]).map(p => p.name),
		referenced: referencedPlaceholders(d.id)
	}));
}

/**
 * Promote a design-local param to a shared decision param.
 * The design's own local row is removed (its value becomes the shared value).
 * Other designs' local params with the same name are kept as overrides unless
 * removeSiblingOverrides is set.
 */
export function shareParam(designId: number, name: string, value: string, removeSiblingOverrides = false): void {
	const db = getDb();
	const decisionId = decisionIdOf(db, designId);
	db.transaction(() => {
		const exists = db.prepare('SELECT id FROM decision_params WHERE decision_id = ? AND name = ?').get(decisionId, name);
		if (exists) {
			db.prepare('UPDATE decision_params SET value = ? WHERE decision_id = ? AND name = ?').run(value, decisionId, name);
		} else {
			const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM decision_params WHERE decision_id = ?').get(decisionId) as { p: number }).p;
			db.prepare('INSERT INTO decision_params (decision_id, position, name, value) VALUES (?, ?, ?, ?)').run(decisionId, pos, name, value);
		}
		db.prepare('DELETE FROM design_params WHERE design_id = ? AND name = ?').run(designId, name);
		if (removeSiblingOverrides) {
			db.prepare('DELETE FROM design_params WHERE name = ? AND design_id IN (SELECT id FROM designs WHERE decision_id = ?)').run(name, decisionId);
		}
	})();
}

/**
 * Demote a shared decision param to a local param of this design.
 * This design keeps the value (its existing override wins, otherwise the shared value);
 * other designs lose the shared default (their own overrides are untouched).
 */
export function unshareParam(designId: number, name: string): void {
	const db = getDb();
	const decisionId = decisionIdOf(db, designId);
	db.transaction(() => {
		const shared = db.prepare('SELECT value FROM decision_params WHERE decision_id = ? AND name = ?').get(decisionId, name) as { value: string } | undefined;
		if (!shared) throw new Error(`Shared param ${name} not found`);
		db.prepare('DELETE FROM decision_params WHERE decision_id = ? AND name = ?').run(decisionId, name);
		const local = db.prepare('SELECT id FROM design_params WHERE design_id = ? AND name = ?').get(designId, name);
		if (!local) {
			const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM design_params WHERE design_id = ?').get(designId) as { p: number }).p;
			db.prepare('INSERT INTO design_params (design_id, position, name, value) VALUES (?, ?, ?, ?)').run(designId, pos, name, shared.value);
		}
	})();
}

/**
 * Profile names must be unique across a design's effective list (shared + local),
 * since single runs/series see both. Returns an error message, or null if the name is free.
 */
export function designProfileNameConflict(designId: number, name: string, excludeProfileId = -1): string | null {
	const db = getDb();
	const decisionId = decisionIdOf(db, designId);
	if (db.prepare('SELECT id FROM decision_param_profiles WHERE decision_id = ? AND name = ?').get(decisionId, name)) {
		return `A shared profile named "${name}" already exists in this decision`;
	}
	if (db.prepare('SELECT id FROM design_param_profiles WHERE design_id = ? AND name = ? AND id != ?').get(designId, name, excludeProfileId)) {
		return `This design already has a profile named "${name}"`;
	}
	return null;
}

export function decisionProfileNameConflict(decisionId: number, name: string, excludeProfileId = -1): string | null {
	const db = getDb();
	if (db.prepare('SELECT id FROM decision_param_profiles WHERE decision_id = ? AND name = ? AND id != ?').get(decisionId, name, excludeProfileId)) {
		return `A shared profile named "${name}" already exists`;
	}
	const local = db.prepare(
		'SELECT d.name FROM design_param_profiles p JOIN designs d ON d.id = p.design_id WHERE d.decision_id = ? AND p.name = ?'
	).all(decisionId, name) as { name: string }[];
	if (local.length > 0) return `Design(s) ${local.map(l => `"${l.name}"`).join(', ')} already have a local profile named "${name}"`;
	return null;
}

/**
 * Promote a design-local profile to a shared decision profile.
 * Fails if a shared profile with that name exists. Other designs' local profiles with
 * the same name are removed when removeSiblingSameName is set, otherwise it fails.
 */
export function shareProfile(designId: number, profileId: number, removeSiblingSameName = false): number {
	const db = getDb();
	const decisionId = decisionIdOf(db, designId);
	const profile = db.prepare('SELECT id, name FROM design_param_profiles WHERE id = ? AND design_id = ?').get(profileId, designId) as { id: number; name: string } | undefined;
	if (!profile) throw new Error(`Profile ${profileId} not found on design ${designId}`);
	if (db.prepare('SELECT id FROM decision_param_profiles WHERE decision_id = ? AND name = ?').get(decisionId, profile.name)) {
		throw new Error(`A shared profile named "${profile.name}" already exists`);
	}
	return db.transaction(() => {
		const siblings = db.prepare(
			'SELECT id FROM design_param_profiles WHERE name = ? AND id != ? AND design_id IN (SELECT id FROM designs WHERE decision_id = ?)'
		).all(profile.name, profileId, decisionId) as { id: number }[];
		if (siblings.length > 0) {
			if (!removeSiblingSameName) throw new Error(`Other designs have a local profile named "${profile.name}"`);
			for (const s of siblings) db.prepare('DELETE FROM design_param_profiles WHERE id = ?').run(s.id);
		}
		const r = db.prepare('INSERT INTO decision_param_profiles (decision_id, name) VALUES (?, ?)').run(decisionId, profile.name);
		const newId = r.lastInsertRowid as number;
		db.prepare(
			'INSERT INTO decision_param_profile_values (profile_id, param_name, value) SELECT ?, param_name, value FROM design_param_profile_values WHERE profile_id = ?'
		).run(newId, profileId);
		db.prepare('DELETE FROM design_param_profiles WHERE id = ?').run(profileId);
		return newId;
	})();
}

/** Demote a shared decision profile to a local profile of this design; other designs lose it. */
export function unshareProfile(designId: number, decisionProfileId: number): number {
	const db = getDb();
	const decisionId = decisionIdOf(db, designId);
	const profile = db.prepare('SELECT id, name FROM decision_param_profiles WHERE id = ? AND decision_id = ?').get(decisionProfileId, decisionId) as { id: number; name: string } | undefined;
	if (!profile) throw new Error(`Shared profile ${decisionProfileId} not found`);
	return db.transaction(() => {
		const r = db.prepare('INSERT INTO design_param_profiles (design_id, name) VALUES (?, ?)').run(designId, profile.name);
		const newId = r.lastInsertRowid as number;
		db.prepare(
			'INSERT INTO design_param_profile_values (profile_id, param_name, value) SELECT ?, param_name, value FROM decision_param_profile_values WHERE profile_id = ?'
		).run(newId, decisionProfileId);
		db.prepare('DELETE FROM decision_param_profiles WHERE id = ?').run(decisionProfileId);
		return newId;
	})();
}
