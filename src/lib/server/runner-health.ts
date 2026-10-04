// Pure helpers that turn runner_snap_* rows (the host that runs pgbench/sysbench) into
// per-interval series and a client-saturation verdict. Kept free of DB and chart types
// so the heuristics can be unit-tested.

export type Row = Record<string, unknown>;

/** pgbench/sysbench/psql threads — the load generators whose saturation we care about. */
const BENCH_PROC_RE = /^(pgbench|sysbench|psql)$/;
const SELF_PROC = 'mybench-runner';

const CPU_TOTAL_COLS = ['cpu_user', 'cpu_nice', 'cpu_system', 'cpu_idle', 'cpu_iowait', 'cpu_irq', 'cpu_softirq', 'cpu_steal'];

function ms(row: Row): number | null {
	const t = Date.parse(String(row._collected_at ?? ''));
	return Number.isFinite(t) ? t : null;
}

function num(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

export interface CpuInterval {
	t: number; // epoch ms of the later sample
	dt: number; // seconds
	busy: number; // % of non-idle, non-iowait time
	user: number;
	system: number;
	iowait: number;
	steal: number;
	irq: number;
	idle: number;
}

/** Per-interval CPU percentages from consecutive /proc/stat-style cumulative jiffies rows. */
export function cpuIntervals(rows: Row[]): CpuInterval[] {
	const out: CpuInterval[] = [];
	for (let i = 1; i < rows.length; i++) {
		const t1 = ms(rows[i]);
		const t0 = ms(rows[i - 1]);
		if (t1 === null || t0 === null || t1 <= t0) continue;
		const d = (col: string) => Math.max(0, (num(rows[i][col]) ?? 0) - (num(rows[i - 1][col]) ?? 0));
		const total = CPU_TOTAL_COLS.reduce((s, c) => s + d(c), 0);
		if (total <= 0) continue;
		const pct = (v: number) => (v / total) * 100;
		out.push({
			t: t1,
			dt: (t1 - t0) / 1000,
			busy: 100 - pct(d('cpu_idle')) - pct(d('cpu_iowait')),
			user: pct(d('cpu_user') + d('cpu_nice')),
			system: pct(d('cpu_system')),
			iowait: pct(d('cpu_iowait')),
			steal: pct(d('cpu_steal')),
			irq: pct(d('cpu_irq') + d('cpu_softirq')),
			idle: pct(d('cpu_idle'))
		});
	}
	return out;
}

/** Busy % per logical CPU, keyed by cpu_id. */
export function perCoreIntervals(cpuRows: Row[]): Map<string, CpuInterval[]> {
	const byCpu = new Map<string, Row[]>();
	for (const r of cpuRows) {
		const id = String(r.cpu_id ?? '');
		if (!id) continue;
		let list = byCpu.get(id);
		if (!list) byCpu.set(id, (list = []));
		list.push(r);
	}
	const out = new Map<string, CpuInterval[]>();
	for (const [id, rows] of [...byCpu.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
		const iv = cpuIntervals(rows);
		if (iv.length > 0) out.set(id, iv);
	}
	return out;
}

export interface CoreAggregate {
	t: number;
	dt: number;
	max: number;
	median: number;
	mean: number;
}

/** At each sample time: busiest core, median core and mean core. One hot core = single-threaded client. */
export function coreAggregates(perCore: Map<string, CpuInterval[]>): CoreAggregate[] {
	const byT = new Map<number, { dt: number; vals: number[] }>();
	for (const ivs of perCore.values()) {
		for (const iv of ivs) {
			let e = byT.get(iv.t);
			if (!e) byT.set(iv.t, (e = { dt: iv.dt, vals: [] }));
			e.vals.push(iv.busy);
		}
	}
	return [...byT.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([t, { dt, vals }]) => {
			const sorted = [...vals].sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
			return { t, dt, max: sorted[sorted.length - 1], median, mean: vals.reduce((a, b) => a + b, 0) / vals.length };
		});
}

export interface ThreadPoint {
	t: number;
	dt: number;
	cpuPct: number; // % of ONE core (100 = a core fully used)
	waitCores: number; // runnable-but-not-running time, in cores (from schedstat)
	nvolPerSec: number; // involuntary context switches per second (preempted)
}

export interface ThreadSeries {
	key: string;
	proc: string;
	tid: number;
	label: string;
	points: ThreadPoint[];
}

/** Per-thread CPU/wait/preemption rates from cumulative per-thread rows. */
export function threadSeries(threadRows: Row[], clkTck = 100): ThreadSeries[] {
	const byThread = new Map<string, Row[]>();
	for (const r of threadRows) {
		const key = `${r.pid}:${r.tid}`;
		let list = byThread.get(key);
		if (!list) byThread.set(key, (list = []));
		list.push(r);
	}
	const out: ThreadSeries[] = [];
	for (const [key, rows] of byThread) {
		const points: ThreadPoint[] = [];
		for (let i = 1; i < rows.length; i++) {
			const t1 = ms(rows[i]);
			const t0 = ms(rows[i - 1]);
			if (t1 === null || t0 === null || t1 <= t0) continue;
			const dt = (t1 - t0) / 1000;
			const dj = (num(rows[i].utime) ?? 0) + (num(rows[i].stime) ?? 0) - (num(rows[i - 1].utime) ?? 0) - (num(rows[i - 1].stime) ?? 0);
			if (dj < 0) continue;
			const dWait = (num(rows[i].wait_time_ns) ?? 0) - (num(rows[i - 1].wait_time_ns) ?? 0);
			const dNvol = (num(rows[i].nvol_ctxt_sw) ?? 0) - (num(rows[i - 1].nvol_ctxt_sw) ?? 0);
			points.push({
				t: t1,
				dt,
				cpuPct: (dj / clkTck / dt) * 100,
				waitCores: Math.max(0, dWait) / 1e9 / dt,
				nvolPerSec: Math.max(0, dNvol) / dt
			});
		}
		if (points.length === 0) continue;
		const proc = String(rows[0].proc ?? rows[0].comm ?? '?');
		const tid = Number(rows[0].tid);
		out.push({ key, proc, tid, label: `${proc}:${tid}`, points });
	}
	return out;
}

export const isBenchProc = (s: ThreadSeries) => BENCH_PROC_RE.test(s.proc);
export const isSelfProc = (s: ThreadSeries) => s.proc === SELF_PROC;

/** Time-weighted mean of one thread's metric. */
export function weightedMean(points: ThreadPoint[], pick: (p: ThreadPoint) => number): number {
	let sum = 0;
	let w = 0;
	for (const p of points) {
		sum += pick(p) * p.dt;
		w += p.dt;
	}
	return w > 0 ? sum / w : 0;
}

function weightedMeanOf(items: { dt: number; v: number }[]): number {
	let sum = 0;
	let w = 0;
	for (const i of items) {
		sum += i.v * i.dt;
		w += i.dt;
	}
	return w > 0 ? sum / w : 0;
}

/** Combine several threads' points per sample time with a reducer (sum / max / mean). */
export function reduceByTime(
	series: ThreadSeries[],
	pick: (p: ThreadPoint) => number,
	reduce: (vals: number[]) => number
): { t: number; dt: number; v: number }[] {
	const byT = new Map<number, { dt: number; vals: number[] }>();
	for (const s of series) {
		for (const p of s.points) {
			let e = byT.get(p.t);
			if (!e) byT.set(p.t, (e = { dt: p.dt, vals: [] }));
			e.vals.push(pick(p));
		}
	}
	return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, { dt, vals }]) => ({ t, dt, v: reduce(vals) }));
}

export const sumOf = (v: number[]) => v.reduce((a, b) => a + b, 0);
export const maxOf = (v: number[]) => Math.max(...v);
export const meanOf = (v: number[]) => (v.length ? sumOf(v) / v.length : 0);

export interface TcpInterval {
	t: number;
	retransPerSec: number;
	retransPct: number | null; // retransmitted segments as % of segments sent
}

export function tcpIntervals(snmpRows: Row[]): TcpInterval[] {
	const out: TcpInterval[] = [];
	for (let i = 1; i < snmpRows.length; i++) {
		const t1 = ms(snmpRows[i]);
		const t0 = ms(snmpRows[i - 1]);
		if (t1 === null || t0 === null || t1 <= t0) continue;
		const dRe = (num(snmpRows[i].tcp_retrans_segs) ?? 0) - (num(snmpRows[i - 1].tcp_retrans_segs) ?? 0);
		const dOut = (num(snmpRows[i].tcp_out_segs) ?? 0) - (num(snmpRows[i - 1].tcp_out_segs) ?? 0);
		if (dRe < 0 || dOut < 0) continue;
		out.push({ t: t1, retransPerSec: dRe / ((t1 - t0) / 1000), retransPct: dOut > 0 ? (dRe / dOut) * 100 : null });
	}
	return out;
}

export type HealthLevel = 'ok' | 'warn' | 'bad';

export interface RunnerHealth {
	level: HealthLevel;
	headline: string;
	findings: string[];
	hottestThreadAvgPct: number | null;
	hottestThreadPeakPct: number | null;
	avgBusyPct: number | null;
	busiestCoreAvgPct: number | null;
	avgStealPct: number | null;
	cpuPsiPeak: number | null;
	retransPct: number | null;
	runnerSelfCpuAvgPct: number | null;
}

export interface RunnerHealthInput {
	stat: CpuInterval[];
	cores: CoreAggregate[];
	benchThreads: ThreadSeries[];
	selfThreads: ThreadSeries[];
	psiRows: Row[];
	tcp: TcpInterval[];
	nproc: number | null;
}

const fmt = (n: number) => `${Math.round(n)}%`;

/**
 * Decide whether the load generator, not the database, is limiting the benchmark.
 * Order matters: a saturated single thread is the most direct proof, then whole-host
 * saturation, then environment noise (steal), then the network.
 */
export function computeRunnerHealth(input: RunnerHealthInput): RunnerHealth {
	const { stat, cores, benchThreads, selfThreads, psiRows, tcp } = input;

	const threadAvgs = benchThreads.map((s) => weightedMean(s.points, (p) => p.cpuPct));
	const hottestAvg = threadAvgs.length ? Math.max(...threadAvgs) : null;
	const hottestPeak = benchThreads.length ? Math.max(...benchThreads.flatMap((s) => s.points.map((p) => p.cpuPct))) : null;

	const avgBusy = stat.length ? weightedMeanOf(stat.map((i) => ({ dt: i.dt, v: i.busy }))) : null;
	const avgSteal = stat.length ? weightedMeanOf(stat.map((i) => ({ dt: i.dt, v: i.steal }))) : null;
	const busiestCore = cores.length ? weightedMeanOf(cores.map((i) => ({ dt: i.dt, v: i.max }))) : null;

	const psiVals = psiRows.map((r) => num(r.cpu_some_avg10)).filter((v): v is number => v !== null);
	const cpuPsiPeak = psiVals.length ? Math.max(...psiVals) : null;

	const retransVals = tcp.map((i) => i.retransPct).filter((v): v is number => v !== null);
	const retransPct = retransVals.length ? weightedMeanOf(retransVals.map((v) => ({ dt: 1, v }))) : null;

	const selfAgg = reduceByTime(selfThreads, (p) => p.cpuPct, sumOf);
	const selfAvg = selfAgg.length ? weightedMeanOf(selfAgg) : null;

	const findings: string[] = [];
	let level: HealthLevel = 'ok';
	const raise = (l: HealthLevel) => {
		if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l;
	};

	if (hottestAvg !== null && hottestAvg >= 85) {
		findings.push(`Client-bound: a benchmark thread averages ${fmt(hottestAvg)} of one core — raise -j / threads, or the client cannot issue queries faster`);
		raise('bad');
	} else if (hottestAvg !== null && hottestAvg >= 60) {
		findings.push(`Client nearly saturated: hottest benchmark thread averages ${fmt(hottestAvg)} of one core`);
		raise('warn');
	}
	if (avgBusy !== null && avgBusy >= 85) {
		findings.push(`Runner CPU saturated: all cores average ${fmt(avgBusy)} busy — a bigger runner is needed`);
		raise('bad');
	}
	if (avgSteal !== null && avgSteal >= 5) {
		findings.push(`CPU steal averages ${avgSteal.toFixed(1)}% — noisy neighbour on a shared VPS; a dedicated-CPU instance would help`);
		raise('warn');
	}
	if (cpuPsiPeak !== null && cpuPsiPeak >= 25) {
		findings.push(`CPU pressure peaked at ${fmt(cpuPsiPeak)} — runnable tasks were waiting for a core`);
		raise('warn');
	}
	if (retransPct !== null && retransPct >= 1) {
		findings.push(`TCP retransmits average ${retransPct.toFixed(2)}% of segments sent — network loss between runner and database`);
		raise('warn');
	}

	const noData = hottestAvg === null && avgBusy === null;
	const headline =
		findings[0] ??
		(noData
			? 'Not enough runner samples (need at least 2 snapshots in the selected phases) to judge client saturation'
			: `Runner looks healthy — hottest thread ${hottestAvg === null ? 'n/a' : fmt(hottestAvg)}, avg CPU ${avgBusy === null ? 'n/a' : fmt(avgBusy)}; ClientRead waits are not caused by client CPU`);

	return {
		level,
		headline,
		findings,
		hottestThreadAvgPct: hottestAvg,
		hottestThreadPeakPct: hottestPeak,
		avgBusyPct: avgBusy,
		busiestCoreAvgPct: busiestCore,
		avgStealPct: avgSteal,
		cpuPsiPeak,
		retransPct,
		runnerSelfCpuAvgPct: selfAvg
	};
}
