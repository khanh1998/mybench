import getDb from '$lib/server/db';

/**
 * Shared steps: one step definition reused by several designs of the same decision.
 *
 * Storage model — linked copies: every design keeps its own full design_steps row
 * (so step ids, run history, plan generation, export and the CLI are untouched).
 * Rows that share content carry the same shared_step_id (→ shared_steps.id), and
 * every write to one of them is propagated to the others by syncSharedStep().
 *
 * Per-design fields (never synced): position, enabled.
 */

type Db = ReturnType<typeof getDb>;

const PER_DESIGN_COLS = new Set(['id', 'design_id', 'position', 'enabled', 'shared_step_id']);

let contentColsCache: string[] | null = null;

/** design_steps columns that make up a step's shared content (derived, so new columns are covered). */
export function stepContentColumns(db: Db = getDb()): string[] {
	if (!contentColsCache) {
		contentColsCache = (db.prepare('PRAGMA table_info(design_steps)').all() as { name: string }[])
			.map(c => c.name)
			.filter(n => !PER_DESIGN_COLS.has(n));
	}
	return contentColsCache;
}

export interface SharedStepInfo {
	id: number;
	name: string;
	type: string;
	designs: { design_id: number; design_name: string; step_id: number }[];
}

function stepRow(db: Db, stepId: number) {
	return db.prepare(
		'SELECT s.id, s.design_id, s.shared_step_id, d.decision_id FROM design_steps s JOIN designs d ON d.id = s.design_id WHERE s.id = ?'
	).get(stepId) as { id: number; design_id: number; shared_step_id: number | null; decision_id: number } | undefined;
}

/** Copy content columns + pgbench scripts from one step row to another. */
function copyStepContent(db: Db, fromStepId: number, toStepId: number): void {
	const cols = stepContentColumns(db);
	db.prepare(
		`UPDATE design_steps SET ${cols.map(c => `${c} = src.${c}`).join(', ')}
		 FROM (SELECT * FROM design_steps WHERE id = ?) AS src
		 WHERE design_steps.id = ?`
	).run(fromStepId, toStepId);
	db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?').run(toStepId);
	db.prepare(
		`INSERT INTO pgbench_scripts (step_id, position, name, weight, weight_expr, script)
		 SELECT ?, position, name, weight, weight_expr, script FROM pgbench_scripts WHERE step_id = ? ORDER BY position`
	).run(toStepId, fromStepId);
}

/** Propagate a shared step's content from `sourceStepId` to every other linked row. Returns affected step ids. */
export function syncSharedStep(sourceStepId: number, db: Db = getDb()): number[] {
	const src = db.prepare('SELECT shared_step_id FROM design_steps WHERE id = ?').get(sourceStepId) as { shared_step_id: number | null } | undefined;
	if (!src?.shared_step_id) return [];
	const others = db.prepare('SELECT id FROM design_steps WHERE shared_step_id = ? AND id != ?').all(src.shared_step_id, sourceStepId) as { id: number }[];
	for (const o of others) copyStepContent(db, sourceStepId, o.id);
	return others.map(o => o.id);
}

/** Delete shared_steps groups that no design uses any more. */
export function cleanupOrphanSharedSteps(db: Db = getDb()): void {
	db.prepare('DELETE FROM shared_steps WHERE id NOT IN (SELECT shared_step_id FROM design_steps WHERE shared_step_id IS NOT NULL)').run();
}

export function listSharedSteps(decisionId: number): SharedStepInfo[] {
	const db = getDb();
	cleanupOrphanSharedSteps(db);
	const rows = db.prepare(`
		SELECT ss.id AS shared_id, s.id AS step_id, s.name, s.type, d.id AS design_id, d.name AS design_name
		FROM shared_steps ss
		JOIN design_steps s ON s.shared_step_id = ss.id
		JOIN designs d ON d.id = s.design_id
		WHERE ss.decision_id = ?
		ORDER BY ss.id, d.id
	`).all(decisionId) as { shared_id: number; step_id: number; name: string; type: string; design_id: number; design_name: string }[];
	const byId = new Map<number, SharedStepInfo>();
	for (const r of rows) {
		let info = byId.get(r.shared_id);
		if (!info) {
			info = { id: r.shared_id, name: r.name, type: r.type, designs: [] };
			byId.set(r.shared_id, info);
		}
		info.designs.push({ design_id: r.design_id, design_name: r.design_name, step_id: r.step_id });
	}
	return [...byId.values()];
}

/** Mark an existing step as shared (creates the group). Returns the shared step id. */
export function shareStep(stepId: number): number {
	const db = getDb();
	const step = stepRow(db, stepId);
	if (!step) throw new Error(`Step ${stepId} not found`);
	if (step.shared_step_id) return step.shared_step_id;
	return db.transaction(() => {
		const sharedId = db.prepare('INSERT INTO shared_steps (decision_id) VALUES (?)').run(step.decision_id).lastInsertRowid as number;
		db.prepare('UPDATE design_steps SET shared_step_id = ? WHERE id = ?').run(sharedId, stepId);
		return sharedId;
	})();
}

/**
 * Add a shared step to a design (inserted at `position`, default: end). The design must
 * belong to the shared step's decision. Returns the new design_steps row id.
 */
export function linkSharedStep(designId: number, sharedStepId: number, position?: number): number {
	const db = getDb();
	const design = db.prepare('SELECT decision_id FROM designs WHERE id = ?').get(designId) as { decision_id: number } | undefined;
	if (!design) throw new Error(`Design ${designId} not found`);
	const shared = db.prepare('SELECT decision_id FROM shared_steps WHERE id = ?').get(sharedStepId) as { decision_id: number } | undefined;
	if (!shared) throw new Error(`Shared step ${sharedStepId} not found`);
	if (shared.decision_id !== design.decision_id) throw new Error('Shared step belongs to a different decision');
	const source = db.prepare('SELECT id, type, name FROM design_steps WHERE shared_step_id = ? ORDER BY id LIMIT 1').get(sharedStepId) as { id: number; type: string; name: string } | undefined;
	if (!source) throw new Error(`Shared step ${sharedStepId} has no content`);

	return db.transaction(() => {
		const count = (db.prepare('SELECT COUNT(*) AS n FROM design_steps WHERE design_id = ?').get(designId) as { n: number }).n;
		const pos = position == null ? count : Math.max(0, Math.min(position, count));
		db.prepare('UPDATE design_steps SET position = position + 1 WHERE design_id = ? AND position >= ?').run(designId, pos);
		const newId = db.prepare(
			'INSERT INTO design_steps (design_id, position, name, type, enabled, shared_step_id) VALUES (?, ?, ?, ?, 1, ?)'
		).run(designId, pos, source.name, source.type, sharedStepId).lastInsertRowid as number;
		copyStepContent(db, source.id, newId);
		return newId;
	})();
}

/** Stop following the shared step in this design only; the row keeps its current content. */
export function detachStep(stepId: number): void {
	const db = getDb();
	db.transaction(() => {
		db.prepare('UPDATE design_steps SET shared_step_id = NULL WHERE id = ?').run(stepId);
		cleanupOrphanSharedSteps(db);
	})();
}

/**
 * Stop sharing everywhere: every linked design keeps its own copy of the current content.
 * Returns the designs that were linked.
 */
export function unshareStep(sharedStepId: number): { design_id: number; design_name: string; step_id: number }[] {
	const db = getDb();
	const linked = db.prepare(
		'SELECT d.id AS design_id, d.name AS design_name, s.id AS step_id FROM design_steps s JOIN designs d ON d.id = s.design_id WHERE s.shared_step_id = ? ORDER BY d.id'
	).all(sharedStepId) as { design_id: number; design_name: string; step_id: number }[];
	db.transaction(() => {
		db.prepare('UPDATE design_steps SET shared_step_id = NULL WHERE shared_step_id = ?').run(sharedStepId);
		db.prepare('DELETE FROM shared_steps WHERE id = ?').run(sharedStepId);
	})();
	return linked;
}

/** Designs (other than `designId`) that share the given step's content. */
export function sharedWith(stepId: number): { design_id: number; design_name: string }[] {
	const db = getDb();
	return db.prepare(`
		SELECT d.id AS design_id, d.name AS design_name
		FROM design_steps s
		JOIN design_steps me ON me.id = ? AND me.shared_step_id IS NOT NULL AND s.shared_step_id = me.shared_step_id AND s.id != me.id
		JOIN designs d ON d.id = s.design_id
		ORDER BY d.id
	`).all(stepId) as { design_id: number; design_name: string }[];
}
