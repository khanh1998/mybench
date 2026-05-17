import { error, json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'invalid id');
	db.prepare('DELETE FROM sysbench_system_runs WHERE id = ?').run(id);
	return json({ ok: true });
};
