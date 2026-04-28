import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const db = getDb();

	// Suites with decision info and aggregated child series stats
	const suiteList = db.prepare(`
		SELECT
			ds.id, ds.name, ds.status, ds.created_at, ds.finished_at,
			ds.decision_id, dec.name AS decision_name,
			COUNT(DISTINCT bs.id) AS series_count,
			COUNT(br.id) AS run_count
		FROM decision_suites ds
		JOIN decisions dec ON ds.decision_id = dec.id
		LEFT JOIN benchmark_series bs ON bs.suite_id = ds.id
		LEFT JOIN benchmark_runs br ON br.series_id = bs.id
		GROUP BY ds.id
		ORDER BY ds.created_at DESC
		LIMIT 100
	`).all() as {
		id: number; name: string; status: string; created_at: string; finished_at: string | null;
		decision_id: number; decision_name: string; series_count: number; run_count: number;
	}[];

	// Series that are NOT part of a suite
	const seriesList = db.prepare(`
		SELECT
			bs.id, bs.name, bs.status, bs.created_at, bs.finished_at,
			bs.design_id, bs.delay_seconds,
			d.name AS design_name,
			dec.id AS decision_id, dec.name AS decision_name
		FROM benchmark_series bs
		JOIN designs d ON bs.design_id = d.id
		JOIN decisions dec ON d.decision_id = dec.id
		WHERE bs.suite_id IS NULL
		ORDER BY bs.created_at DESC
		LIMIT 200
	`).all() as {
		id: number; name: string; status: string; created_at: string; finished_at: string | null;
		design_id: number; delay_seconds: number;
		design_name: string; decision_id: number; decision_name: string;
	}[];

	const seriesIds = seriesList.map(s => s.id);
	const seriesRuns = seriesIds.length > 0
		? db.prepare(`
				SELECT id, series_id, status, profile_name, tps, latency_avg_ms, started_at, finished_at
				FROM benchmark_runs
				WHERE series_id IN (${seriesIds.join(',')})
				ORDER BY id ASC
		`).all() as {
			id: number; series_id: number; status: string; profile_name: string;
			tps: number | null; latency_avg_ms: number | null; started_at: string; finished_at: string | null;
		}[]
		: [];

	const standaloneRuns = db.prepare(`
		SELECT
			br.id, br.status, br.started_at, br.finished_at, br.tps, br.latency_avg_ms,
			br.profile_name, br.name,
			br.design_id,
			d.name AS design_name,
			dec.id AS decision_id, dec.name AS decision_name
		FROM benchmark_runs br
		JOIN designs d ON br.design_id = d.id
		JOIN decisions dec ON d.decision_id = dec.id
		WHERE br.series_id IS NULL
		ORDER BY br.started_at DESC
		LIMIT 200
	`).all() as {
		id: number; status: string; started_at: string; finished_at: string | null;
		tps: number | null; latency_avg_ms: number | null; profile_name: string; name: string;
		design_id: number; design_name: string; decision_id: number; decision_name: string;
	}[];

	// Group runs by series
	const runsBySeries = new Map<number, typeof seriesRuns>();
	for (const run of seriesRuns) {
		const arr = runsBySeries.get(run.series_id) ?? [];
		arr.push(run);
		runsBySeries.set(run.series_id, arr);
	}

	const seriesWithRuns = seriesList.map(s => ({
		...s,
		runs: runsBySeries.get(s.id) ?? []
	}));

	// Collect unique decisions for filter
	const decisionsMap = new Map<number, string>();
	for (const s of suiteList) decisionsMap.set(s.decision_id, s.decision_name);
	for (const s of seriesList) decisionsMap.set(s.decision_id, s.decision_name);
	for (const r of standaloneRuns) decisionsMap.set(r.decision_id, r.decision_name);
	const decisions = [...decisionsMap.entries()].map(([id, name]) => ({ id, name }))
		.sort((a, b) => a.name.localeCompare(b.name));

	return { suiteList, seriesWithRuns, standaloneRuns, decisions };
};
