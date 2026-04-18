import { parseSysbenchFinalOutput, type SysbenchSummary } from '$lib/sysbench-results';

function parseJson<T>(value: string | null | undefined): T | null {
	if (!value?.trim()) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

export function getSysbenchStepOutput(step: { stdout?: string | null; stderr?: string | null }): string {
	return [step.stdout ?? '', step.stderr ?? '']
		.filter((part) => part.trim().length > 0)
		.join('\n');
}

export function resolveSysbenchSummary(step: {
	sysbench_summary_json?: string | null;
	stdout?: string | null;
	stderr?: string | null;
}): SysbenchSummary | null {
	const stored = parseJson<SysbenchSummary>(step.sysbench_summary_json);
	const parsed = parseSysbenchFinalOutput(getSysbenchStepOutput(step));

	const merged: SysbenchSummary = {
		tps: stored?.tps ?? parsed.tps,
		qps: stored?.qps ?? parsed.qps,
		latency_avg_ms: stored?.latency_avg_ms ?? parsed.latency_avg_ms,
		latency_min_ms: stored?.latency_min_ms ?? parsed.latency_min_ms,
		latency_max_ms: stored?.latency_max_ms ?? parsed.latency_max_ms,
		latency_p95_ms: stored?.latency_p95_ms ?? parsed.latency_p95_ms,
		total_time_secs: stored?.total_time_secs ?? parsed.total_time_secs,
		total_events: stored?.total_events ?? parsed.total_events,
		transactions: stored?.transactions ?? parsed.transactions,
		errors: stored?.errors ?? parsed.errors,
		threads: stored?.threads ?? parsed.threads,
		rows_per_sec: stored?.rows_per_sec ?? parsed.rows_per_sec,
		queries_read: stored?.queries_read ?? parsed.queries_read,
		queries_write: stored?.queries_write ?? parsed.queries_write,
		queries_other: stored?.queries_other ?? parsed.queries_other,
		queries_total: stored?.queries_total ?? parsed.queries_total,
		reconnects: stored?.reconnects ?? parsed.reconnects,
	};

	if (Object.values(merged).every((v) => v == null)) return null;
	return merged;
}
