import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { importRun, importResultIntoRun } from '$lib/server/run-importer';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();

	const { design_id, run_id, result } = body;

	if (!result) throw error(400, 'Missing result');
	if (!result.run) throw error(400, 'Missing result.run');

	// If run_id provided, re-import into an existing run (e.g. after a failed SSH download)
	if (run_id) {
		const existing = db.prepare('SELECT id FROM benchmark_runs WHERE id = ?').get(Number(run_id));
		if (!existing) throw error(400, `Run ${run_id} not found`);
		importResultIntoRun(Number(run_id), result);
		return json({ run_id: Number(run_id) });
	}

	if (!design_id) throw error(400, 'Missing design_id');

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(design_id));
	if (!design) throw error(400, 'Design not found');

	const runId = importRun(Number(design_id), result);
	return json({ run_id: runId });
};
