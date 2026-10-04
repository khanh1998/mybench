import { describe, expect, it } from 'vitest';
import {
	computeRunnerHealth,
	coreAggregates,
	cpuIntervals,
	isBenchProc,
	isSelfProc,
	perCoreIntervals,
	tcpIntervals,
	threadSeries,
	type Row
} from './runner-health';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const ts = (sec: number) => new Date(T0 + sec * 1000).toISOString();

// 10s apart; 100 jiffies/s per core.
function statRow(sec: number, busyJiffies: number, idleJiffies: number, steal = 0): Row {
	return {
		_collected_at: ts(sec),
		cpu_user: busyJiffies, cpu_nice: 0, cpu_system: 0, cpu_idle: idleJiffies,
		cpu_iowait: 0, cpu_irq: 0, cpu_softirq: 0, cpu_steal: steal
	};
}

function threadRow(sec: number, pid: number, tid: number, proc: string, cpuJiffies: number, waitNs = 0, nvol = 0): Row {
	return { _collected_at: ts(sec), pid, tid, proc, comm: proc, utime: cpuJiffies, stime: 0, wait_time_ns: waitNs, nvol_ctxt_sw: nvol };
}

describe('cpuIntervals', () => {
	it('computes busy/steal percentages from jiffy deltas', () => {
		const iv = cpuIntervals([statRow(0, 0, 0), statRow(10, 75, 25, 0)]);
		expect(iv).toHaveLength(1);
		expect(iv[0].busy).toBeCloseTo(75);
		expect(iv[0].idle).toBeCloseTo(25);
		const withSteal = cpuIntervals([statRow(0, 0, 0, 0), statRow(10, 60, 30, 10)]);
		expect(withSteal[0].steal).toBeCloseTo(10);
	});

	it('skips counter resets and non-increasing timestamps', () => {
		expect(cpuIntervals([statRow(0, 100, 100), statRow(0, 200, 200)])).toHaveLength(0);
		expect(cpuIntervals([statRow(0, 100, 100)])).toHaveLength(0);
	});
});

describe('per-core aggregation', () => {
	it('exposes one hot core even when the aggregate looks idle', () => {
		const rows: Row[] = [];
		for (const sec of [0, 10]) {
			const hot = sec === 0 ? 0 : 1000; // core0: 100% busy over 10s
			rows.push({ ...statRow(sec, hot, sec === 0 ? 0 : 0), cpu_id: '0' });
			for (const id of ['1', '2', '3']) rows.push({ ...statRow(sec, 0, sec === 0 ? 0 : 1000), cpu_id: id });
		}
		const agg = coreAggregates(perCoreIntervals(rows));
		expect(agg).toHaveLength(1);
		expect(agg[0].max).toBeCloseTo(100);
		expect(agg[0].mean).toBeCloseTo(25);
		expect(agg[0].median).toBeCloseTo(0);
	});
});

describe('threadSeries', () => {
	it('converts jiffies to % of one core and wait ns to cores', () => {
		const series = threadSeries([
			threadRow(0, 10, 10, 'pgbench', 0, 0, 0),
			threadRow(10, 10, 10, 'pgbench', 900, 2_000_000_000, 50)
		]);
		expect(series).toHaveLength(1);
		const p = series[0].points[0];
		expect(p.cpuPct).toBeCloseTo(90);
		expect(p.waitCores).toBeCloseTo(0.2);
		expect(p.nvolPerSec).toBeCloseTo(5);
		expect(series[0].label).toBe('pgbench:10');
		expect(isBenchProc(series[0])).toBe(true);
		expect(isSelfProc(series[0])).toBe(false);
	});

	it('ignores threads seen only once (no interval yet)', () => {
		expect(threadSeries([threadRow(0, 1, 1, 'pgbench', 5)])).toHaveLength(0);
	});
});

describe('tcpIntervals', () => {
	it('computes retransmit rate and percentage', () => {
		const iv = tcpIntervals([
			{ _collected_at: ts(0), tcp_retrans_segs: 0, tcp_out_segs: 0 },
			{ _collected_at: ts(10), tcp_retrans_segs: 20, tcp_out_segs: 1000 }
		]);
		expect(iv[0].retransPerSec).toBeCloseTo(2);
		expect(iv[0].retransPct).toBeCloseTo(2);
	});
});

function health(opts: { threadCpu?: number; hostBusy?: number; steal?: number; psi?: number; retransPct?: number }) {
	const threads = threadSeries([
		threadRow(0, 5, 5, 'pgbench', 0),
		threadRow(10, 5, 5, 'pgbench', (opts.threadCpu ?? 10) * 10)
	]);
	const busy = opts.hostBusy ?? 10;
	const stat = cpuIntervals([statRow(0, 0, 0, 0), statRow(10, busy * 10 - (opts.steal ?? 0) * 10, (100 - busy) * 10, (opts.steal ?? 0) * 10)]);
	return computeRunnerHealth({
		stat,
		cores: [],
		benchThreads: threads,
		selfThreads: [],
		psiRows: opts.psi === undefined ? [] : [{ cpu_some_avg10: opts.psi }],
		tcp: opts.retransPct === undefined ? [] : [{ t: 1, retransPerSec: 1, retransPct: opts.retransPct }],
		nproc: 8
	});
}

describe('computeRunnerHealth', () => {
	it('flags a saturated benchmark thread as client-bound even if the host is mostly idle', () => {
		const h = health({ threadCpu: 98, hostBusy: 14 });
		expect(h.level).toBe('bad');
		expect(h.headline).toMatch(/Client-bound/);
		expect(h.hottestThreadAvgPct).toBeCloseTo(98);
	});

	it('flags whole-host saturation', () => {
		const h = health({ threadCpu: 40, hostBusy: 92 });
		expect(h.level).toBe('bad');
		expect(h.findings.join(' ')).toMatch(/bigger runner/);
	});

	it('warns on CPU steal (noisy neighbour)', () => {
		const h = health({ threadCpu: 30, hostBusy: 40, steal: 8 });
		expect(h.level).toBe('warn');
		expect(h.findings.join(' ')).toMatch(/steal/i);
	});

	it('warns on TCP retransmits and CPU pressure', () => {
		const h = health({ retransPct: 2.5, psi: 40 });
		expect(h.level).toBe('warn');
		expect(h.findings).toHaveLength(2);
	});

	it('reports healthy when nothing is saturated', () => {
		const h = health({ threadCpu: 20, hostBusy: 18 });
		expect(h.level).toBe('ok');
		expect(h.headline).toMatch(/healthy/);
		expect(h.findings).toHaveLength(0);
	});

	it('does not claim anything when there is no data', () => {
		const h = computeRunnerHealth({ stat: [], cores: [], benchThreads: [], selfThreads: [], psiRows: [], tcp: [], nproc: null });
		expect(h.hottestThreadAvgPct).toBeNull();
		expect(h.level).toBe('ok');
		expect(h.headline).toMatch(/Not enough runner samples/);
	});
});
