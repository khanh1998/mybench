import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { importRun } from '$lib/server/run-importer';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();

	const { design_id, result } = body;

	if (!design_id) throw error(400, 'Missing design_id');
	if (!result) throw error(400, 'Missing result');
	if (!result.run) throw error(400, 'Missing result.run');

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(design_id));
	if (!design) throw error(400, 'Design not found');

	const runId = importRun(Number(design_id), result);
	return json({ run_id: runId });
};
