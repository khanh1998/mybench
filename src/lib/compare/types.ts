export interface CompareRunInfo {
  id: number;
  name: string | null;
  status: string;
  tps: number | null;
  latency_avg_ms: number | null;
  latency_stddev_ms: number | null;
  transactions: number | null;
  failed_transactions?: number | null;
  transaction_type?: string | null;
  scaling_factor?: number | null;
  query_mode?: string | null;
  number_of_clients?: number | null;
  number_of_threads?: number | null;
  maximum_tries?: number | null;
  duration_secs?: number | null;
  initial_connection_time_ms?: number | null;
  // sysbench-specific
  bench_type?: 'pgbench' | 'sysbench' | null;
  qps?: number | null;
  latency_p95_ms?: number | null;
  sysbench_threads?: number | null;
  sysbench_total_time_secs?: number | null;
  sysbench_total_events?: number | null;
  sysbench_errors?: number | null;
  profile_name: string | null;
  run_params: string | null;
  started_at: string;
  bench_started_at: string | null;
  post_started_at: string | null;
  finished_at: string | null;
  design_id?: number;
  design_name?: string | null;
  compare_label?: string;
  compare_short_label?: string;
}
