import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(Number(params.id));
	if (!server) throw error(404, 'Not found');
	return json(server);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body = await request.json();
	const { name, host, user, port, private_key, remote_dir, log_dir } = body;
	db.prepare(
		'UPDATE ec2_servers SET name=?, host=?, user=?, port=?, private_key=?, remote_dir=?, log_dir=? WHERE id=?'
	).run(name, host, user, port, private_key, remote_dir, log_dir, Number(params.id));
	const server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(Number(params.id));
	return json(server);
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	db.prepare('DELETE FROM ec2_servers WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
