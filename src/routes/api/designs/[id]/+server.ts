import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';
import type { PgbenchScript, DesignParam } from '$lib/types';

export const GET: RequestHandler = ({ params: routeParams }) => {
	const db = getDb();
	const designId = Number(routeParams.id);
	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId);
	if (!design) throw error(404, 'Not found');
	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(designId) as { id: number; type: string; [key: string]: unknown }[];
	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position'
	).all(designId) as PgbenchScript[];

	const scriptsByStep = new Map<number, PgbenchScript[]>();
	for (const ps of pgbenchScripts) {
		const arr = scriptsByStep.get(ps.step_id) ?? [];
		arr.push(ps);
		scriptsByStep.set(ps.step_id, arr);
	}

	const stepsWithScripts = steps.map(s => ({
		...s,
		pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []) : undefined
	}));

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(designId) as DesignParam[];

	return json({ ...design as object, steps: stepsWithScripts, params: designParams });
};

export const PUT: RequestHandler = async ({ params: routeParams, request }) => {
	const db = getDb();
	const designId = Number(routeParams.id);
	const body = await request.json();
	db.prepare(
		'UPDATE designs SET name=?, description=?, server_id=?, database=?, pre_collect_secs=?, post_collect_secs=?, snapshot_interval_seconds=? WHERE id=?'
	).run(body.name, body.description ?? '', body.server_id ?? null, body.database ?? '', body.pre_collect_secs ?? 0, body.post_collect_secs ?? 60, body.snapshot_interval_seconds ?? 30, designId);

	const deleteScripts = db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?');
	const insertScript = db.prepare(
		'INSERT INTO pgbench_scripts (step_id, position, name, weight, weight_expr, script) VALUES (?, ?, ?, ?, ?, ?)'
	);
	const deleteParams = db.prepare('DELETE FROM design_params WHERE design_id = ?');
	const insertParam = db.prepare(
		'INSERT INTO design_params (design_id, position, name, value) VALUES (?, ?, ?, ?)'
	);

	if (body.steps) {
		const upsert = db.prepare(
			`INSERT INTO design_steps (id, design_id, position, name, type, script, pgbench_options, enabled, duration_secs, no_transaction)
       VALUES (@id, @design_id, @position, @name, @type, @script, @pgbench_options, @enabled, @duration_secs, @no_transaction)
       ON CONFLICT(id) DO UPDATE SET
         position=excluded.position, name=excluded.name, type=excluded.type,
         script=excluded.script, pgbench_options=excluded.pgbench_options, enabled=excluded.enabled,
         duration_secs=excluded.duration_secs, no_transaction=excluded.no_transaction`
		);

		const doUpsert = db.transaction(() => {
			for (const s of body.steps) {
				upsert.run({ ...s, design_id: designId, duration_secs: s.duration_secs ?? 0, no_transaction: s.no_transaction ?? 0 });
				if (s.type === 'pgbench') {
					deleteScripts.run(s.id);
					for (const ps of s.pgbench_scripts ?? []) {
						insertScript.run(s.id, ps.position, ps.name, ps.weight, ps.weight_expr ?? null, ps.script);
					}
				}
			}
			deleteParams.run(designId);
			for (const p of body.params ?? []) {
				insertParam.run(designId, p.position, p.name, p.value);
			}
		});
		doUpsert();
	} else {
		deleteParams.run(designId);
		for (const p of body.params ?? []) {
			insertParam.run(designId, p.position, p.name, p.value);
		}
	}

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId);
	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(designId) as { id: number; type: string; [key: string]: unknown }[];
	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position'
	).all(designId) as PgbenchScript[];

	const scriptsByStep = new Map<number, PgbenchScript[]>();
	for (const ps of pgbenchScripts) {
		const arr = scriptsByStep.get(ps.step_id) ?? [];
		arr.push(ps);
		scriptsByStep.set(ps.step_id, arr);
	}

	const stepsWithScripts = steps.map(s => ({
		...s,
		pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []) : undefined
	}));

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(designId) as DesignParam[];

	return json({ ...design as object, steps: stepsWithScripts, params: designParams });
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	db.prepare('DELETE FROM designs WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
