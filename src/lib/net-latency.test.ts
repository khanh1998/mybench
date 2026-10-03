import { describe, expect, it } from 'vitest';
import { formatPingLatency, formatSelect1Latency, parseNetLatency } from './net-latency';

const sample = JSON.stringify({
	select1: { samples: 100, min_ms: 0.3, avg_ms: 0.41, p50_ms: 0.4, p95_ms: 0.55, max_ms: 0.9, stddev_ms: 0.05 },
	ping: { sent: 20, received: 19, loss_pct: 5, min_ms: 0.35, avg_ms: 0.402, max_ms: 0.512, mdev_ms: 0.045 }
});

describe('net-latency', () => {
	it('formats both probes', () => {
		const n = parseNetLatency(sample);
		expect(formatSelect1Latency(n)).toBe('0.400 ms (p95 0.550)');
		expect(formatPingLatency(n)).toBe('0.402 ms (max 0.512, 5% loss)');
	});

	it('returns null for missing, invalid or blocked-ICMP data', () => {
		expect(parseNetLatency(null)).toBeNull();
		expect(parseNetLatency('not json')).toBeNull();
		expect(formatSelect1Latency(null)).toBeNull();
		const blocked = parseNetLatency(
			JSON.stringify({ ping: { sent: 20, received: 0, loss_pct: 100, min_ms: 0, avg_ms: 0, max_ms: 0, mdev_ms: 0 }, ping_error: 'no replies' })
		);
		expect(formatPingLatency(blocked)).toBeNull();
	});
});
