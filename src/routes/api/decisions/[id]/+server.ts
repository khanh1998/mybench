import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(params.id));
	if (!decision) throw error(404, 'Not found');
	return json(decision);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body = await request.json();
	db.prepare('UPDATE decisions SET name=?, description=? WHERE id=?').run(body.name, body.description ?? '', Number(params.id));
	return json(db.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(params.id)));
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	db.prepare('DELETE FROM decisions WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
