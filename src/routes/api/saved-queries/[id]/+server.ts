import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body = await request.json();
	db.prepare('UPDATE saved_queries SET name=?, sql=? WHERE id=?').run(body.name, body.sql, Number(params.id));
	return json(db.prepare('SELECT * FROM saved_queries WHERE id = ?').get(Number(params.id)));
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	const q = db.prepare('SELECT decision_id FROM saved_queries WHERE id = ?').get(Number(params.id)) as { decision_id: number | null } | undefined;
	if (!q) throw error(404, 'Not found');
	if (q.decision_id === null) throw error(403, 'Cannot delete built-in global queries');
	db.prepare('DELETE FROM saved_queries WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
