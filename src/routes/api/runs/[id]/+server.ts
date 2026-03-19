import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { stopRun } from '$lib/server/run-manager';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(Number(params.id));
	if (!run) throw error(404, 'Not found');
	const steps = db.prepare('SELECT * FROM run_step_results WHERE run_id = ? ORDER BY position').all(Number(params.id));
	return json({ ...run as object, steps });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const runId = Number(params.id);
	const db = getDb();
	await stopRun(runId);
	db.prepare(`UPDATE benchmark_runs SET status='stopped', finished_at=datetime('now') WHERE id=? AND status='running'`).run(runId);
	return json({ ok: true });
};
