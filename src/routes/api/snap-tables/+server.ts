import { json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const db = getDb();
	const runIds = (url.searchParams.get('run_ids') ?? '')
		.split(',')
		.map(Number)
		.filter(Boolean);

	if (runIds.length === 0) return json([]);

	const placeholders = runIds.map(() => '?').join(', ');
	const result: { name: string; columns: string[] }[] = [];

	for (const snapTable of Object.values(SNAP_TABLE_MAP)) {
		const tableExists = db
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
			.get(snapTable);
		if (!tableExists) continue;

		const row = db
			.prepare(`SELECT COUNT(*) as cnt FROM ${snapTable} WHERE _run_id IN (${placeholders})`)
			.get(...runIds) as { cnt: number };
		if (!row || row.cnt === 0) continue;

		const cols = (db.prepare(`PRAGMA table_info(${snapTable})`).all() as { name: string }[])
			.map((r) => r.name)
			.filter((c) => !c.startsWith('_'));

		result.push({ name: snapTable, columns: cols });
	}

	return json(result);
};
