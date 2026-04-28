import getDb from '$lib/server/db';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const suiteId = Number(params.suiteId);

	const suite = db.prepare(`
		SELECT ds.*, dec.name AS decision_name
		FROM decision_suites ds
		JOIN decisions dec ON ds.decision_id = dec.id
		WHERE ds.id = ?
	`).get(suiteId) as {
		id: number; decision_id: number; decision_name: string;
		name: string; status: string; created_at: string; finished_at: string | null;
	} | undefined;
	if (!suite) throw error(404, 'Suite not found');

	const seriesList = db.prepare(`
		SELECT bs.id, bs.name, bs.status, bs.created_at, bs.finished_at,
		       bs.design_id, bs.delay_seconds,
		       d.name AS design_name
		FROM benchmark_series bs
		JOIN designs d ON bs.design_id = d.id
		WHERE bs.suite_id = ?
		ORDER BY bs.id ASC
	`).all(suiteId) as {
		id: number; name: string; status: string; created_at: string; finished_at: string | null;
		design_id: number; delay_seconds: number; design_name: string;
	}[];

	const seriesIds = seriesList.map(s => s.id);
	const runs = seriesIds.length > 0
		? db.prepare(`
				SELECT id, series_id, design_id, status, profile_name, tps, latency_avg_ms, started_at, finished_at
				FROM benchmark_runs
				WHERE series_id IN (${seriesIds.join(',')})
				ORDER BY id ASC
		`).all() as {
			id: number; series_id: number; design_id: number; status: string;
			profile_name: string; tps: number | null; latency_avg_ms: number | null;
			started_at: string; finished_at: string | null;
		}[]
		: [];

	return { suite, seriesList, runs };
};
