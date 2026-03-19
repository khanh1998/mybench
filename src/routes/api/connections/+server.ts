import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	const db = getDb();
	const servers = db.prepare('SELECT * FROM pg_servers ORDER BY id').all();
	return json(servers);
};

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();
	const { name, host, port, username, password } = body;
	const result = db.prepare(
		'INSERT INTO pg_servers (name, host, port, username, password) VALUES (?, ?, ?, ?, ?)'
	).run(name, host ?? 'localhost', port ?? 5432, username ?? 'postgres', password ?? '');
	const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(result.lastInsertRowid);
	return json(server, { status: 201 });
};
