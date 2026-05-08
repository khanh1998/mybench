import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { stopRun } from '$lib/server/run-manager';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const suiteId = Number(params.id);

	const suite = db.prepare(`
		SELECT ds.*, dec.name AS decision_name
		FROM decision_suites ds
		JOIN decisions dec ON ds.decision_id = dec.id
		WHERE ds.id = ?
	`).get(suiteId) as Record<string, unknown> | undefined;
	if (!suite) return json({ error: 'Suite not found' }, { status: 404 });

	const seriesList = db.prepare(`
		SELECT bs.*, d.name AS design_name
		FROM benchmark_series bs
		JOIN designs d ON bs.design_id = d.id
		WHERE bs.suite_id = ?
		ORDER BY bs.id ASC
	`).all(suiteId) as Record<string, unknown>[];

	const seriesIds = seriesList.map(s => s.id as number);
	const runs = seriesIds.length > 0
		? db.prepare(`
				SELECT id, series_id, design_id, status, profile_name, tps, latency_avg_ms, started_at, finished_at
				FROM benchmark_runs
				WHERE series_id IN (${seriesIds.join(',')})
				ORDER BY id ASC
		`).all() as Record<string, unknown>[]
		: [];

	return json({ suite, seriesList, runs });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const suiteId = Number(params.id);
	const db = getDb();
	const seriesIds = (db.prepare(`SELECT id FROM benchmark_series WHERE suite_id = ?`).all(suiteId) as { id: number }[]).map(s => s.id);
	if (seriesIds.length > 0) {
		const runningRuns = db.prepare(`SELECT id FROM benchmark_runs WHERE series_id IN (${seriesIds.join(',')}) AND status = 'running'`).all() as { id: number }[];
		for (const run of runningRuns) await stopRun(run.id);
		db.prepare(`DELETE FROM benchmark_runs WHERE series_id IN (${seriesIds.join(',')})`).run();
		db.prepare(`DELETE FROM benchmark_series WHERE suite_id = ?`).run(suiteId);
	}
	db.prepare(`DELETE FROM decision_suites WHERE id = ?`).run(suiteId);
	return json({ ok: true });
};
