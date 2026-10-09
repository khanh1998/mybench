import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Design-level params that override a shared decision param of the same name (single runs / series only). */
export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const rows = db.prepare(`
		SELECT dp.name, dp.value, d.id AS design_id, d.name AS design_name
		FROM design_params dp
		JOIN designs d ON d.id = dp.design_id
		WHERE d.decision_id = ?
		  AND dp.name IN (SELECT name FROM decision_params WHERE decision_id = ?)
		ORDER BY dp.name, d.id
	`).all(Number(params.id), Number(params.id));
	return json(rows);
};
