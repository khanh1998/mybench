import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	const db = getDb();
	const servers = db.prepare('SELECT * FROM ec2_servers ORDER BY id').all();
	return json(servers);
};

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();
	const { name, host, user, port, private_key, remote_dir, log_dir } = body;
	const result = db
		.prepare(
			'INSERT INTO ec2_servers (name, host, user, port, private_key, remote_dir, log_dir) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.run(
			name,
			host ?? '',
			user ?? 'ec2-user',
			port ?? 22,
			private_key ?? '',
			remote_dir ?? '~/mybench-bench',
			log_dir ?? '/tmp/mybench-logs'
		);
	const server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(result.lastInsertRowid);
	return json(server, { status: 201 });
};
