import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';
import type { DecisionParam } from '$lib/types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const decisionId = Number(params.id);
	const rows = db.prepare('SELECT * FROM decision_params WHERE decision_id = ? ORDER BY position').all(decisionId) as DecisionParam[];
	return json(rows);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const decisionId = Number(params.id);
	const body = await request.json() as { params: { position: number; name: string; value: string }[] };

	const del = db.prepare('DELETE FROM decision_params WHERE decision_id = ?');
	const ins = db.prepare('INSERT INTO decision_params (decision_id, position, name, value) VALUES (?, ?, ?, ?)');

	db.transaction(() => {
		del.run(decisionId);
		for (const p of body.params ?? []) {
			ins.run(decisionId, p.position, p.name, p.value);
		}
	})();

	const rows = db.prepare('SELECT * FROM decision_params WHERE decision_id = ? ORDER BY position').all(decisionId) as DecisionParam[];
	return json(rows);
};
