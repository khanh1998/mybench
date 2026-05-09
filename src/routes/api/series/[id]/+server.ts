import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { completeRun } from '$lib/server/run-manager';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const seriesId = Number(params.id);

	const series = db.prepare('SELECT * FROM benchmark_series WHERE id = ?').get(seriesId);
	if (!series) return json({ error: 'Series not found' }, { status: 404 });

	const runs = db.prepare(`
		SELECT id, status, profile_name, name, tps, latency_avg_ms, started_at, finished_at, series_id
		FROM benchmark_runs WHERE series_id = ? ORDER BY id
	`).all(seriesId);

	return json({ series, runs });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const seriesId = Number(params.id);
	const db = getDb();
	const runningRuns = db.prepare(`SELECT id FROM benchmark_runs WHERE series_id = ? AND status = 'running'`).all(seriesId) as { id: number }[];
	for (const run of runningRuns) completeRun(run.id);
	db.prepare(`DELETE FROM benchmark_runs WHERE series_id = ?`).run(seriesId);
	db.prepare(`DELETE FROM benchmark_series WHERE id = ?`).run(seriesId);
	return json({ ok: true });
};
