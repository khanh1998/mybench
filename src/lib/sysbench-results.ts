export interface SysbenchSummary {
	tps: number | null;
	qps: number | null;
	latency_avg_ms: number | null;
	latency_min_ms: number | null;
	latency_max_ms: number | null;
	latency_p95_ms: number | null;
	total_time_secs: number | null;
	total_events: number | null;
	transactions: number | null;
	errors: number | null;
	threads: number | null;
	rows_per_sec: number | null;
	queries_read: number | null;
	queries_write: number | null;
	queries_other: number | null;
	queries_total: number | null;
	reconnects: number | null;
}

export function parseSysbenchFinalOutput(output: string): SysbenchSummary {
	const result: SysbenchSummary = {
		tps: null, qps: null, latency_avg_ms: null, latency_min_ms: null,
		latency_max_ms: null, latency_p95_ms: null, total_time_secs: null,
		total_events: null, transactions: null, errors: null, threads: null,
		rows_per_sec: null,
		queries_read: null, queries_write: null, queries_other: null, queries_total: null,
		reconnects: null,
	};

	// Standard sysbench SQL statistics block
	const tpsMatch = output.match(/transactions:\s+\d+\s+\((\d+(?:\.\d+)?)\s+per sec\.\)/);
	if (tpsMatch) result.tps = parseFloat(tpsMatch[1]);

	const txMatch = output.match(/transactions:\s+(\d+)/);
	if (txMatch) result.transactions = parseInt(txMatch[1], 10);

	const qpsMatch = output.match(/queries:\s+\d+\s+\((\d+(?:\.\d+)?)\s+per sec\.\)/);
	if (qpsMatch) result.qps = parseFloat(qpsMatch[1]);

	const errMatch = output.match(/ignored errors:\s+(\d+)/);
	if (errMatch) result.errors = parseInt(errMatch[1], 10);

	const reconnMatch = output.match(/reconnects:\s+(\d+)/);
	if (reconnMatch) result.reconnects = parseInt(reconnMatch[1], 10);

	// Query breakdown (read/write/other/total under "queries performed:")
	const readMatch = output.match(/read:\s+(\d+)/);
	if (readMatch) result.queries_read = parseInt(readMatch[1], 10);

	const writeMatch = output.match(/write:\s+(\d+)/);
	if (writeMatch) result.queries_write = parseInt(writeMatch[1], 10);

	const otherMatch = output.match(/other:\s+(\d+)/);
	if (otherMatch) result.queries_other = parseInt(otherMatch[1], 10);

	const totalQMatch = output.match(/total:\s+(\d+)/);
	if (totalQMatch) result.queries_total = parseInt(totalQMatch[1], 10);

	// Latency block
	const minMatch = output.match(/min:\s+([\d.]+)/);
	if (minMatch) result.latency_min_ms = parseFloat(minMatch[1]);

	const avgMatch = output.match(/avg:\s+([\d.]+)/);
	if (avgMatch) result.latency_avg_ms = parseFloat(avgMatch[1]);

	const maxMatch = output.match(/max:\s+([\d.]+)/);
	if (maxMatch) result.latency_max_ms = parseFloat(maxMatch[1]);

	const p95Match = output.match(/95th percentile:\s+([\d.]+)/);
	if (p95Match) {
		const v = parseFloat(p95Match[1]);
		result.latency_p95_ms = v > 0 ? v : null; // 0.00 means not tracked
	}

	const timeMatch = output.match(/total time:\s+([\d.]+)s/);
	if (timeMatch) result.total_time_secs = parseFloat(timeMatch[1]);

	const eventsMatch = output.match(/total number of events:\s+(\d+)/);
	if (eventsMatch) result.total_events = parseInt(eventsMatch[1], 10);

	// Custom Lua scripts that print their own rows/sec line
	const rowsPerSecMatch = output.match(/rows\/sec[^:]*:\s*([\d.]+)/);
	if (rowsPerSecMatch) result.rows_per_sec = parseFloat(rowsPerSecMatch[1]);

	// threads + fallback avg TPS/QPS from progress lines when no standard block
	const progressRe = /\[\s*\d+s\s*\]\s+thds:\s+(\d+)\s+tps:\s+([\d.]+)\s+qps:\s+([\d.]+)/g;
	const tpsVals: number[] = [];
	const qpsVals: number[] = [];
	let lastThreads: number | null = null;
	let m: RegExpExecArray | null;
	while ((m = progressRe.exec(output)) !== null) {
		lastThreads = parseInt(m[1], 10);
		tpsVals.push(parseFloat(m[2]));
		qpsVals.push(parseFloat(m[3]));
	}
	if (lastThreads !== null) result.threads = lastThreads;
	if (result.tps === null && tpsVals.length > 0) {
		result.tps = tpsVals.reduce((a, b) => a + b, 0) / tpsVals.length;
	}
	if (result.qps === null && qpsVals.length > 0) {
		result.qps = qpsVals.reduce((a, b) => a + b, 0) / qpsVals.length;
	}

	return result;
}
