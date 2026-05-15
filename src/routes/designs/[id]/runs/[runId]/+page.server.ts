import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const runId = Number(params.runId);
	const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(runId);
	if (!run) return { run: null };
	const steps = db.prepare('SELECT * FROM run_step_results WHERE run_id = ? ORDER BY position').all(runId) as { step_id: number; [key: string]: unknown }[];
	const perfRows = db.prepare('SELECT * FROM run_step_perf WHERE run_id = ?').all(runId) as { id: number; step_id: number; [key: string]: unknown }[];
	const perfEvents = db.prepare('SELECT * FROM run_step_perf_events WHERE run_id = ? ORDER BY event_name').all(runId) as { step_id: number; [key: string]: unknown }[];
	const eventsByStep = new Map<number, typeof perfEvents>();
	for (const event of perfEvents) {
		const arr = eventsByStep.get(event.step_id) ?? [];
		arr.push(event);
		eventsByStep.set(event.step_id, arr);
	}
	const perfByStep = new Map<number, Array<Record<string, unknown>>>();
	for (const perf of perfRows) {
		const arr = perfByStep.get(perf.step_id) ?? [];
		arr.push({ ...perf, events: perf.mode === 'stat' ? (eventsByStep.get(perf.step_id) ?? []) : [] });
		perfByStep.set(perf.step_id, arr);
	}
	const stepsWithPerf = steps.map((step) => ({ ...step, perfs: perfByStep.get(step.step_id) ?? [] }));
	return { run: { ...run as object, steps: stepsWithPerf } };
};
