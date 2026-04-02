import { parsePgbenchFinalOutput, type PgbenchStepSummary } from '$lib/pgbench-results';

function parseJson<T>(value: string | null | undefined): T | null {
	if (!value?.trim()) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

export function getPgbenchStepOutput(step: { stdout?: string | null; stderr?: string | null }): string {
	return [step.stdout ?? '', step.stderr ?? '']
		.filter((part) => part.trim().length > 0)
		.join('\n');
}

export function mergePgbenchSummary(
	storedSummary: PgbenchStepSummary | null,
	parsedSummary: PgbenchStepSummary | null
): PgbenchStepSummary | null {
	if (!storedSummary && !parsedSummary) return null;

	const summary: PgbenchStepSummary = {
		tps: storedSummary?.tps ?? parsedSummary?.tps ?? null,
		latency_avg_ms: storedSummary?.latency_avg_ms ?? parsedSummary?.latency_avg_ms ?? null,
		latency_stddev_ms: storedSummary?.latency_stddev_ms ?? parsedSummary?.latency_stddev_ms ?? null,
		transactions: storedSummary?.transactions ?? parsedSummary?.transactions ?? null,
		failed_transactions: storedSummary?.failed_transactions ?? parsedSummary?.failed_transactions ?? null,
		transaction_type: storedSummary?.transaction_type ?? parsedSummary?.transaction_type ?? null,
		scaling_factor: storedSummary?.scaling_factor ?? parsedSummary?.scaling_factor ?? null,
		query_mode: storedSummary?.query_mode ?? parsedSummary?.query_mode ?? null,
		number_of_clients: storedSummary?.number_of_clients ?? parsedSummary?.number_of_clients ?? null,
		number_of_threads: storedSummary?.number_of_threads ?? parsedSummary?.number_of_threads ?? null,
		maximum_tries: storedSummary?.maximum_tries ?? parsedSummary?.maximum_tries ?? null,
		duration_secs: storedSummary?.duration_secs ?? parsedSummary?.duration_secs ?? null,
		initial_connection_time_ms: storedSummary?.initial_connection_time_ms ?? parsedSummary?.initial_connection_time_ms ?? null
	};

	if (Object.values(summary).every((value) => value == null)) return null;
	return summary;
}

export function resolvePgbenchSummary(step: {
	pgbench_summary_json?: string | null;
	stdout?: string | null;
	stderr?: string | null;
}): PgbenchStepSummary | null {
	const storedSummary = parseJson<PgbenchStepSummary>(step.pgbench_summary_json);
	const parsedSummary = parsePgbenchFinalOutput(getPgbenchStepOutput(step)).summary;
	return mergePgbenchSummary(storedSummary, parsedSummary);
}
