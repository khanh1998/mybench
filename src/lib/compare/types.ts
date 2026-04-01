export interface CompareRunInfo {
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
  design_id?: number;
  design_name?: string | null;
  compare_label?: string;
  compare_short_label?: string;
}
