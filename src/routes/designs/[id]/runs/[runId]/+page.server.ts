import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const runId = Number(params.runId);
	const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(runId);
	if (!run) return { run: null };
	const steps = db.prepare('SELECT * FROM run_step_results WHERE run_id = ? ORDER BY position').all(runId);
	return { run: { ...run as object, steps } };
};
