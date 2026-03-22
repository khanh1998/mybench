import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const metrics = db.prepare(
		'SELECT * FROM decision_metrics WHERE decision_id = ? ORDER BY position, id'
	).all(Number(params.id));
	return json(metrics);
};

export const POST: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const { name, category, description, sql, higher_is_better } = await request.json();
	if (!name?.trim() || !sql?.trim()) throw error(400, 'name and sql are required');
	const result = db.prepare(
		`INSERT INTO decision_metrics (decision_id, name, category, description, sql, higher_is_better, position)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM decision_metrics WHERE decision_id = ?))`
	).run(Number(params.id), name.trim(), category ?? 'Custom', description ?? '', sql.trim(), higher_is_better ? 1 : 0, Number(params.id));
	return json(db.prepare('SELECT * FROM decision_metrics WHERE id = ?').get(result.lastInsertRowid), { status: 201 });
};
