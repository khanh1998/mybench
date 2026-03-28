import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { startRun } from '$lib/server/run-executor';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const db = getDb();
	const designId = url.searchParams.get('design_id');
	const runs = designId
		? db.prepare('SELECT * FROM benchmark_runs WHERE design_id = ? ORDER BY id DESC').all(Number(designId))
		: db.prepare('SELECT * FROM benchmark_runs ORDER BY id DESC LIMIT 50').all();
	return json(runs);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { design_id, server_id, database, snapshot_interval_seconds, profile_id, name } = body;
	if (!design_id) throw error(400, 'Missing design_id');
	try {
		const runId = startRun(Number(design_id), { server_id, database, snapshot_interval_seconds, profile_id, name });
		return json({ run_id: runId }, { status: 201 });
	} catch (e: unknown) {
		throw error(400, e instanceof Error ? e.message : String(e));
	}
};
