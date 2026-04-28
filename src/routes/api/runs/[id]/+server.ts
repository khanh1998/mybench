import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { stopRun } from '$lib/server/run-manager';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(Number(params.id));
	if (!run) throw error(404, 'Not found');
	const runId = Number(params.id);
	const steps = db.prepare('SELECT * FROM run_step_results WHERE run_id = ? ORDER BY position').all(runId) as { step_id: number; [key: string]: unknown }[];
	const perfRows = db.prepare('SELECT * FROM run_step_perf WHERE run_id = ?').all(runId) as { step_id: number; [key: string]: unknown }[];
	const perfEvents = db.prepare('SELECT * FROM run_step_perf_events WHERE run_id = ? ORDER BY event_name').all(runId) as { step_id: number; [key: string]: unknown }[];
	const eventsByStep = new Map<number, typeof perfEvents>();
	for (const event of perfEvents) {
		const arr = eventsByStep.get(event.step_id) ?? [];
		arr.push(event);
		eventsByStep.set(event.step_id, arr);
	}
	const perfByStep = new Map(perfRows.map((perf) => [perf.step_id, { ...perf, events: eventsByStep.get(perf.step_id) ?? [] }]));
	return json({ ...run as object, steps: steps.map((step) => ({ ...step, perf: perfByStep.get(step.step_id) ?? null })) });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const runId = Number(params.id);
	const run = db.prepare('SELECT id FROM benchmark_runs WHERE id = ?').get(runId);
	if (!run) throw error(404, 'Not found');

	const body = await request.json() as { name?: string; notes?: string };
	const fields: string[] = [];
	const values: unknown[] = [];
	if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name); }
	if (body.notes !== undefined) { fields.push('notes = ?'); values.push(body.notes); }
	if (fields.length === 0) throw error(400, 'No fields to update');

	values.push(runId);
	db.prepare(`UPDATE benchmark_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
	return json({ updated: true });
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	const runId = Number(params.id);
	const db = getDb();
	await stopRun(runId);
	if (url.searchParams.get('action') === 'delete') {
		db.prepare(`DELETE FROM benchmark_runs WHERE id = ?`).run(runId);
	} else {
		db.prepare(`UPDATE benchmark_runs SET status='stopped', finished_at=datetime('now') WHERE id=? AND status='running'`).run(runId);
	}
	return json({ ok: true });
};
