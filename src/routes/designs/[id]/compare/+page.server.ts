import getDb from '$lib/server/db';
import { resolvePgbenchSummary } from '$lib/pgbench-summary';
import { resolveSysbenchSummary } from '$lib/sysbench-summary';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const id = Number(params.id);

	interface CompareRunRow {
		id: number;
		name: string | null;
		status: string;
		tps: number | null;
		latency_avg_ms: number | null;
		latency_stddev_ms: number | null;
		transactions: number | null;
		profile_name: string | null;
		run_params: string | null;
		started_at: string;
		bench_started_at: string | null;
		post_started_at: string | null;
		finished_at: string | null;
		bench_step_type: string | null;
		pgbench_summary_json: string | null;
		sysbench_summary_json: string | null;
		bench_stdout: string | null;
		bench_stderr: string | null;
	}

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as {
		id: number;
		decision_id: number;
		name: string;
	} | null;
	if (!design) return { design: null, decision: null, runs: [], metrics: [] };

	const decision = db
		.prepare('SELECT * FROM decisions WHERE id = ?')
		.get(design.decision_id) as { id: number; name: string } | null;

	const rawRuns = db
		.prepare(
			`SELECT br.id, br.name, br.status, br.tps, br.latency_avg_ms, br.latency_stddev_ms, br.transactions,
			        br.profile_name, br.run_params, br.started_at, br.bench_started_at, br.post_started_at, br.finished_at,
			        br.series_id,
			        rs.type AS bench_step_type,
			        rs.pgbench_summary_json,
			        rs.sysbench_summary_json,
			        substr(rs.stdout, 1, 5000) AS bench_stdout,
			        substr(rs.stderr, 1, 2000) AS bench_stderr
			 FROM benchmark_runs br
			 LEFT JOIN run_step_results rs ON rs.id = (
			   SELECT id
			   FROM run_step_results
			   WHERE run_id = br.id AND type IN ('pgbench', 'sysbench')
			   ORDER BY position
			   LIMIT 1
			 )
			 WHERE br.design_id = ? AND br.status = 'completed' ORDER BY br.id DESC`
		)
		.all(id) as (CompareRunRow & { series_id: number | null })[];

	const runs = rawRuns.map((run) => {
		const isSysbench = run.bench_step_type === 'sysbench';

		if (isSysbench) {
			const summary = resolveSysbenchSummary({
				sysbench_summary_json: run.sysbench_summary_json,
				stdout: run.bench_stdout,
				stderr: run.bench_stderr
			});
			return {
				...run,
				bench_type: 'sysbench' as const,
				tps: summary?.tps ?? run.tps,
				latency_avg_ms: summary?.latency_avg_ms ?? run.latency_avg_ms,
				latency_stddev_ms: null,
				transactions: summary?.transactions ?? run.transactions,
				qps: summary?.qps ?? null,
				latency_p95_ms: summary?.latency_p95_ms ?? null,
				sysbench_threads: summary?.threads ?? null,
				sysbench_total_time_secs: summary?.total_time_secs ?? null,
				sysbench_total_events: summary?.total_events ?? null,
				sysbench_errors: summary?.errors ?? null,
				failed_transactions: null,
				transaction_type: null,
				scaling_factor: null,
				query_mode: null,
				number_of_clients: null,
				number_of_threads: null,
				maximum_tries: null,
				duration_secs: null,
				initial_connection_time_ms: null
			};
		}

		const summary = resolvePgbenchSummary({
			pgbench_summary_json: run.pgbench_summary_json,
			stdout: run.bench_stdout,
			stderr: run.bench_stderr
		});
		return {
			...run,
			bench_type: 'pgbench' as const,
			tps: summary?.tps ?? run.tps,
			latency_avg_ms: summary?.latency_avg_ms ?? run.latency_avg_ms,
			latency_stddev_ms: summary?.latency_stddev_ms ?? run.latency_stddev_ms,
			transactions: summary?.transactions ?? run.transactions,
			failed_transactions: summary?.failed_transactions ?? null,
			transaction_type: summary?.transaction_type ?? null,
			scaling_factor: summary?.scaling_factor ?? null,
			query_mode: summary?.query_mode ?? null,
			number_of_clients: summary?.number_of_clients ?? null,
			number_of_threads: summary?.number_of_threads ?? null,
			maximum_tries: summary?.maximum_tries ?? null,
			duration_secs: summary?.duration_secs ?? null,
			initial_connection_time_ms: summary?.initial_connection_time_ms ?? null
		};
	});

	const metrics = decision
		? db
				.prepare('SELECT * FROM decision_metrics WHERE decision_id = ? ORDER BY position')
				.all(decision.id)
		: [];

	const seriesList = db
		.prepare('SELECT id, name FROM benchmark_series WHERE design_id = ? ORDER BY id')
		.all(id) as { id: number; name: string }[];

	return { design, decision, runs, metrics, seriesList };
};
