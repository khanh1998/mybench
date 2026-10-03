// Pre-run client→DB latency probe stored by mybench-runner in benchmark_runs.net_latency (JSON).

export interface SelectLatencyStats {
	samples: number;
	min_ms: number;
	avg_ms: number;
	p50_ms: number;
	p95_ms: number;
	max_ms: number;
	stddev_ms: number;
}

export interface PingLatencyStats {
	sent: number;
	received: number;
	loss_pct: number;
	min_ms: number;
	avg_ms: number;
	max_ms: number;
	mdev_ms: number;
}

export interface NetLatency {
	select1?: SelectLatencyStats | null;
	select1_error?: string | null;
	ping?: PingLatencyStats | null;
	ping_error?: string | null;
}

export function parseNetLatency(raw: string | null | undefined): NetLatency | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as NetLatency) : null;
	} catch {
		return null;
	}
}

function ms(v: number): string {
	return `${v.toFixed(3)} ms`;
}

/** "0.402 ms (p95 0.512)" — null when the SELECT 1 probe produced no data. */
export function formatSelect1Latency(n: NetLatency | null): string | null {
	const s = n?.select1;
	if (!s) return null;
	return `${ms(s.p50_ms)} (p95 ${s.p95_ms.toFixed(3)})`;
}

/** "0.402 ms (max 0.512, 5% loss)" — null when ping is unavailable or got no replies. */
export function formatPingLatency(n: NetLatency | null): string | null {
	const p = n?.ping;
	if (!p || p.received === 0) return null;
	const extra = [`max ${p.max_ms.toFixed(3)}`];
	if (p.loss_pct > 0) extra.push(`${p.loss_pct.toFixed(0)}% loss`);
	return `${ms(p.avg_ms)} (${extra.join(', ')})`;
}
