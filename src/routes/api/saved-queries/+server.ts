import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const db = getDb();
	const decisionId = url.searchParams.get('decision_id');

	let queries;
	if (decisionId) {
		queries = db.prepare(
			'SELECT * FROM saved_queries WHERE decision_id IS NULL OR decision_id = ? ORDER BY id'
		).all(Number(decisionId));
	} else {
		queries = db.prepare('SELECT * FROM saved_queries ORDER BY id').all();
	}
	return json(queries);
};

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();
	const result = db.prepare(
		'INSERT INTO saved_queries (decision_id, name, sql) VALUES (?, ?, ?)'
	).run(body.decision_id ?? null, body.name, body.sql);
	const query = db.prepare('SELECT * FROM saved_queries WHERE id = ?').get(result.lastInsertRowid);
	return json(query, { status: 201 });
};
