export interface SysbenchProgressPoint {
	elapsedSec: number;
	tps: number;
	qps: number;
	reads: number;
	writes: number;
	others: number;
	latP95Ms: number;
	errors: number;
	reconnects: number;
	threads: number;
}

export function parseSysbenchProgress(output: string): SysbenchProgressPoint[] {
	// [ 5s ] thds: 2 tps: 1234.56 qps: 1234.56 (r/w/o: 0.00/1234.56/0.00) lat (ms,95%): 3.96 err/s: 0.00 reconn/s: 0.00
	const re = /\[\s*(\d+)s\s*\]\s+thds:\s+(\d+)\s+tps:\s+([\d.]+)\s+qps:\s+([\d.]+)\s+\(r\/w\/o:\s+([\d.]+)\/([\d.]+)\/([\d.]+)\)\s+lat\s+\(ms,95%\):\s+([\d.]+)\s+err\/s:\s+([\d.]+)\s+reconn\/s:\s+([\d.]+)/g;
	const results: SysbenchProgressPoint[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(output)) !== null) {
		results.push({
			elapsedSec: parseInt(m[1], 10),
			threads: parseInt(m[2], 10),
			tps: parseFloat(m[3]),
			qps: parseFloat(m[4]),
			reads: parseFloat(m[5]),
			writes: parseFloat(m[6]),
			others: parseFloat(m[7]),
			latP95Ms: parseFloat(m[8]),
			errors: parseFloat(m[9]),
			reconnects: parseFloat(m[10]),
		});
	}
	return results;
}
