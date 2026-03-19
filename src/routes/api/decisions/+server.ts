import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	const db = getDb();
	const decisions = db.prepare('SELECT * FROM decisions ORDER BY id DESC').all();
	return json(decisions);
};

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();
	const result = db.prepare('INSERT INTO decisions (name, description) VALUES (?, ?)').run(body.name, body.description ?? '');
	const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(result.lastInsertRowid);
	return json(decision, { status: 201 });
};
