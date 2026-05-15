import { error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url }) => {
	const runId = Number(params.id);
	const stepId = Number(params.stepId);
	const mode = url.searchParams.get('mode') ?? 'record';
	const db = getDb();
	const row = db.prepare(`
		SELECT perf_script_output
		FROM run_step_perf
		WHERE run_id = ? AND step_id = ? AND mode = ?
	`).get(runId, stepId, mode) as { perf_script_output: string } | undefined;
	if (!row) throw error(404, 'Perf script not found');

	return new Response(row.perf_script_output ?? '', {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': `attachment; filename="run-${runId}-step-${stepId}-${mode}.perf-script.txt"`
		}
	});
};
