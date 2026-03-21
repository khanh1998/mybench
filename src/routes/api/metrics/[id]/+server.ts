import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const metric = db.prepare('SELECT * FROM metrics WHERE id = ?').get(Number(params.id)) as { is_builtin: number } | undefined;
	if (!metric) throw error(404, 'Not found');
	if (metric.is_builtin) throw error(403, 'Built-in metrics cannot be edited');
	const { name, category, description, sql, higher_is_better } = await request.json();
	db.prepare(
		`UPDATE metrics SET name=?, category=?, description=?, sql=?, higher_is_better=? WHERE id=?`
	).run(name, category, description ?? '', sql, higher_is_better ? 1 : 0, Number(params.id));
	return json(db.prepare('SELECT * FROM metrics WHERE id = ?').get(Number(params.id)));
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	const metric = db.prepare('SELECT * FROM metrics WHERE id = ?').get(Number(params.id)) as { is_builtin: number } | undefined;
	if (!metric) throw error(404, 'Not found');
	if (metric.is_builtin) throw error(403, 'Built-in metrics cannot be deleted');
	db.prepare('DELETE FROM metrics WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
