import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	if (!db.prepare('SELECT id FROM metrics WHERE id = ?').get(Number(params.id))) throw error(404, 'Not found');
	const { name, category, description, sql, higher_is_better } = await request.json();
	if (!name?.trim() || !sql?.trim()) throw error(400, 'name and sql are required');
	db.prepare(
		`UPDATE metrics SET name=?, category=?, description=?, sql=?, higher_is_better=? WHERE id=?`
	).run(name.trim(), category, description ?? '', sql.trim(), higher_is_better ? 1 : 0, Number(params.id));
	return json(db.prepare('SELECT * FROM metrics WHERE id = ?').get(Number(params.id)));
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	if (!db.prepare('SELECT id FROM metrics WHERE id = ?').get(Number(params.id))) throw error(404, 'Not found');
	db.prepare('DELETE FROM metrics WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
