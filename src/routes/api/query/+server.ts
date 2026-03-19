import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();
	const { sql, params = [] } = body as { sql: string; params: unknown[] };

	if (!sql?.trim()) throw error(400, 'SQL is required');

	// Safety: only allow SELECT and WITH statements
	const normalized = sql.trim().toUpperCase();
	if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
		throw error(400, 'Only SELECT queries are allowed');
	}

	try {
		const stmt = db.prepare(sql);
		const rows = stmt.all(...params);
		const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
		return json({ columns, rows });
	} catch (err: unknown) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
};
