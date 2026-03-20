import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(Number(params.id));
	if (!server) throw error(404, 'Not found');
	return json(server);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body = await request.json();
	const { name, host, port, username, password, ssl } = body;
	db.prepare(
		'UPDATE pg_servers SET name=?, host=?, port=?, username=?, password=?, ssl=? WHERE id=?'
	).run(name, host, port, username, password, ssl ? 1 : 0, Number(params.id));
	const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(Number(params.id));
	return json(server);
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	db.prepare('DELETE FROM pg_servers WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
