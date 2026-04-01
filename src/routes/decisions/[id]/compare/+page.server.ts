import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
  const db = getDb();
  const id = Number(params.id);

  const decision = db.prepare('SELECT id, name FROM decisions WHERE id = ?').get(id) as {
    id: number;
    name: string;
  } | null;

  if (!decision) return { decision: null, designs: [], runs: [] };

  const designs = db
    .prepare('SELECT id, name FROM designs WHERE decision_id = ? ORDER BY id')
    .all(id) as { id: number; name: string }[];

  const runs = db
    .prepare(
      `SELECT br.id, br.name, br.status, br.tps, br.latency_avg_ms, br.latency_stddev_ms, br.transactions,
              br.profile_name, br.run_params, br.started_at, br.bench_started_at, br.post_started_at, br.finished_at,
              d.id AS design_id, d.name AS design_name
         FROM benchmark_runs br
         JOIN designs d ON d.id = br.design_id
        WHERE d.decision_id = ? AND br.status = 'completed'
        ORDER BY d.id ASC, br.id DESC`
    )
    .all(id);

  return { decision, designs, runs };
};
