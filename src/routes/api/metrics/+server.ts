import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	const db = getDb();
	const metrics = db.prepare('SELECT * FROM metrics ORDER BY category, position, id').all();
	return json(metrics);
};

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const { name, category, description, sql, higher_is_better } = await request.json();
	if (!name?.trim() || !sql?.trim()) throw error(400, 'name and sql are required');
	const result = db.prepare(
		`INSERT INTO metrics (name, category, description, sql, is_builtin, higher_is_better, position)
     VALUES (?, ?, ?, ?, 0, ?, (SELECT COALESCE(MAX(position),0)+1 FROM metrics))`
	).run(name.trim(), category ?? 'Custom', description ?? '', sql.trim(), higher_is_better ? 1 : 0);
	const metric = db.prepare('SELECT * FROM metrics WHERE id = ?').get(result.lastInsertRowid);
	return json(metric, { status: 201 });
};
