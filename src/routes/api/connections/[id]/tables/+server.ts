import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const server = db.prepare('SELECT id FROM pg_servers WHERE id = ?').get(Number(params.id));
	if (!server) throw error(404, 'Server not found');

	const tables = db
		.prepare('SELECT table_name, enabled FROM pg_stat_table_selections WHERE server_id = ? ORDER BY table_name')
		.all(Number(params.id));
	return json(tables);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const body = await request.json() as { table_name: string; enabled: boolean }[];
	const update = db.prepare(
		'UPDATE pg_stat_table_selections SET enabled = ? WHERE server_id = ? AND table_name = ?'
	);
	const doUpdate = db.transaction(() => {
		for (const item of body) {
			update.run(item.enabled ? 1 : 0, Number(params.id), item.table_name);
		}
	});
	doUpdate();
	return json({ ok: true });
};
