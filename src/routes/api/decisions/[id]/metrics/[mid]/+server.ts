import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const metric = db.prepare('SELECT id FROM decision_metrics WHERE id = ? AND decision_id = ?').get(Number(params.mid), Number(params.id));
	if (!metric) throw error(404, 'Not found');
	const { name, category, description, sql, higher_is_better, time_col, value_col } = await request.json();
	if (!name?.trim() || !sql?.trim()) throw error(400, 'name and sql are required');
	db.prepare(
		`UPDATE decision_metrics SET name=?, category=?, description=?, sql=?, higher_is_better=?, time_col=?, value_col=? WHERE id=?`
	).run(name.trim(), category ?? 'Custom', description ?? '', sql.trim(), higher_is_better ? 1 : 0, time_col ?? '', value_col ?? '', Number(params.mid));
	return json(db.prepare('SELECT * FROM decision_metrics WHERE id = ?').get(Number(params.mid)));
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	const metric = db.prepare('SELECT id FROM decision_metrics WHERE id = ? AND decision_id = ?').get(Number(params.mid), Number(params.id));
	if (!metric) throw error(404, 'Not found');
	db.prepare('DELETE FROM decision_metrics WHERE id = ?').run(Number(params.mid));
	return json({ ok: true });
};
