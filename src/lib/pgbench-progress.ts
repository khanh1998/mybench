// Pure client-side re-export of pgbench progress parsing logic.
// Mirrors parsePgbenchProgress in src/lib/server/pgbench.ts but safe to import in Svelte components.

export interface PgbenchProgressPoint {
	elapsedSec: number;
	tps: number;
	latAvgMs: number;
	latStddevMs: number;
	failed: number;
}

export function parsePgbenchProgress(stdout: string): PgbenchProgressPoint[] {
	// pgbench -P N writes lines to stdout like:
	// progress: 5.0 s, 1234.5 tps, lat 0.810 ms stddev 0.123 ms, 0 failed
	const results: PgbenchProgressPoint[] = [];
	const re = /^progress:\s+([\d.]+)\s+s,\s+([\d.]+)\s+tps,\s+lat\s+([\d.]+)\s+ms\s+stddev\s+([\d.]+)\s+ms,?\s*(\d+)\s+failed/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stdout)) !== null) {
		results.push({
			elapsedSec: parseFloat(m[1]),
			tps: parseFloat(m[2]),
			latAvgMs: parseFloat(m[3]),
			latStddevMs: parseFloat(m[4]),
			failed: parseInt(m[5], 10)
		});
	}
	// Fallback: older pgbench format without "failed" count
	if (results.length === 0) {
		const reFallback = /^progress:\s+([\d.]+)\s+s,\s+([\d.]+)\s+tps,\s+lat\s+([\d.]+)\s+ms\s+stddev\s+([\d.]+)/gm;
		let mf: RegExpExecArray | null;
		while ((mf = reFallback.exec(stdout)) !== null) {
			results.push({
				elapsedSec: parseFloat(mf[1]),
				tps: parseFloat(mf[2]),
				latAvgMs: parseFloat(mf[3]),
				latStddevMs: parseFloat(mf[4]),
				failed: 0
			});
		}
	}
	return results;
}
