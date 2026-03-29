import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const id = Number(params.id);

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as {
		id: number;
		decision_id: number;
		name: string;
	} | null;
	if (!design) return { design: null, decision: null, runs: [], metrics: [] };

	const decision = db
		.prepare('SELECT * FROM decisions WHERE id = ?')
		.get(design.decision_id) as { id: number; name: string } | null;

	const runs = db
		.prepare(
			`SELECT id, name, status, tps, latency_avg_ms, latency_stddev_ms, transactions,
			        profile_name, run_params, started_at, bench_started_at, post_started_at, finished_at
			 FROM benchmark_runs WHERE design_id = ? AND status = 'completed' ORDER BY id DESC`
		)
		.all(id);

	const metrics = decision
		? db
				.prepare('SELECT * FROM decision_metrics WHERE decision_id = ? ORDER BY position')
				.all(decision.id)
		: [];

	return { design, decision, runs, metrics };
};
