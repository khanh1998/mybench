import getDb from '$lib/server/db';
import { resolvePgbenchSummary } from '$lib/pgbench-summary';
import { resolveSysbenchSummary } from '$lib/sysbench-summary';
import type { ComparePerfEvent, CompareStepPerf } from '$lib/compare/types';
import type { PageServerLoad } from './$types';

function loadPerfByRun(db: ReturnType<typeof getDb>, runIds: number[]): Map<number, CompareStepPerf[]> {
  const perfByRun = new Map<number, CompareStepPerf[]>();
  if (runIds.length === 0) return perfByRun;
  const placeholders = runIds.map(() => '?').join(',');
  const perfRows = db.prepare(`
    SELECT p.*, rs.name AS step_name, rs.type AS step_type, rs.position AS step_position
    FROM run_step_perf p
    LEFT JOIN run_step_results rs ON rs.run_id = p.run_id AND rs.step_id = p.step_id
    WHERE p.run_id IN (${placeholders})
    ORDER BY p.run_id, rs.position, p.step_id
  `).all(...runIds) as (CompareStepPerf & { run_id: number; step_position: number | null })[];
  const events = db.prepare(`
    SELECT *
    FROM run_step_perf_events
    WHERE run_id IN (${placeholders})
    ORDER BY event_name
  `).all(...runIds) as (ComparePerfEvent & { run_id: number; step_id: number })[];
  const eventsByStep = new Map<string, ComparePerfEvent[]>();
  for (const event of events) {
    const key = `${event.run_id}:${event.step_id}`;
    const list = eventsByStep.get(key) ?? [];
    list.push({
      event_name: event.event_name,
      counter_value: event.counter_value,
      unit: event.unit,
      runtime_secs: event.runtime_secs,
      percent_running: event.percent_running,
      per_transaction: event.per_transaction,
      derived_value: event.derived_value,
      derived_unit: event.derived_unit
    });
    eventsByStep.set(key, list);
  }
  for (const row of perfRows) {
    const list = perfByRun.get(row.run_id) ?? [];
    list.push({
      step_id: row.step_id,
      step_name: row.step_name,
      step_type: row.step_type,
      status: row.status,
      scope: row.scope,
      cgroup: row.cgroup,
      command: row.command,
      raw_output: row.raw_output,
      raw_error: row.raw_error,
      warnings_json: row.warnings_json,
      started_at: row.started_at,
      finished_at: row.finished_at,
      events: eventsByStep.get(`${row.run_id}:${row.step_id}`) ?? []
    });
    perfByRun.set(row.run_id, list);
  }
  return perfByRun;
}

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
    host_config: string | null;
    design_id: number;
    design_name: string | null;
    bench_step_type: string | null;
    pgbench_summary_json: string | null;
    sysbench_summary_json: string | null;
    bench_stdout: string | null;
    bench_stderr: string | null;
  }

  const decision = db.prepare('SELECT id, name FROM decisions WHERE id = ?').get(id) as {
    id: number;
    name: string;
  } | null;

  if (!decision) return { decision: null, designs: [], runs: [] };

  const designs = db
    .prepare('SELECT id, name FROM designs WHERE decision_id = ? ORDER BY id')
    .all(id) as { id: number; name: string }[];

  const rawRuns = db
    .prepare(
      `SELECT br.id, br.name, br.status, br.tps, br.latency_avg_ms, br.latency_stddev_ms, br.transactions,
              br.profile_name, br.run_params, br.started_at, br.bench_started_at, br.post_started_at, br.finished_at,
              br.host_config, d.id AS design_id, d.name AS design_name,
              rs.type AS bench_step_type,
              rs.pgbench_summary_json,
              rs.sysbench_summary_json,
              substr(rs.stdout, 1, 5000) AS bench_stdout,
              substr(rs.stderr, 1, 2000) AS bench_stderr
         FROM benchmark_runs br
         JOIN designs d ON d.id = br.design_id
         LEFT JOIN run_step_results rs ON rs.id = (
           SELECT id
           FROM run_step_results
           WHERE run_id = br.id AND type IN ('pgbench', 'sysbench')
           ORDER BY position
           LIMIT 1
         )
        WHERE d.decision_id = ? AND br.status = 'completed'
        ORDER BY d.id ASC, br.id DESC`
    )
    .all(id) as CompareRunRow[];
  const perfByRun = loadPerfByRun(db, rawRuns.map((run) => run.id));

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
        perf: perfByRun.get(run.id) ?? [],
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
      perf: perfByRun.get(run.id) ?? [],
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

  return { decision, designs, runs };
};
