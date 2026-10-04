import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// End-to-end through the real schema migrations, importer and telemetry builder:
// a mybench-runner result carrying runner_snapshots must land in runner_snap_* tables
// with correct column types and surface as a "Runner" telemetry section.

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const ts = (sec: number) => new Date(T0 + sec * 1000).toISOString();

async function loadModules(dataDir: string) {
	process.env.DATA_DIR = dataDir;
	vi.resetModules();
	const db = await import('./db');
	const importer = await import('./run-importer');
	const telemetry = await import('./run-telemetry');
	return { db, importer, telemetry };
}

function thread(sec: number, pid: number, tid: number, proc: string, utime: number, waitNs: number, nvol: number) {
	return {
		_collected_at: ts(sec), pid, tid, proc, comm: proc, state: 'R',
		utime, stime: 0, processor: 2, run_time_ns: utime * 1e7, wait_time_ns: waitNs,
		timeslices: 10, vol_ctxt_sw: 5, nvol_ctxt_sw: nvol
	};
}

describe('runner metrics end to end', () => {
	const originalDataDir = process.env.DATA_DIR;
	let dataDir = '';

	afterEach(() => {
		process.env.DATA_DIR = originalDataDir;
		if (dataDir) rmSync(dataDir, { recursive: true, force: true });
		dataDir = '';
	});

	it('migrates the proc_collect_runner column with default on and creates runner tables', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-runner-e2e-'));
		const { db: dbModule } = await loadModules(dataDir);
		const db = dbModule.getDb();

		const stepCols = db.prepare(`PRAGMA table_info(design_steps)`).all() as { name: string; dflt_value: string | null }[];
		expect(stepCols.find((c) => c.name === 'proc_collect_runner')?.dflt_value).toBe('1');
		const runCols = db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[];
		expect(runCols.map((c) => c.name)).toContain('runner_config');
		const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_snap_%'`).all() as { name: string }[]).map((r) => r.name);
		expect(tables).toEqual(expect.arrayContaining([
			'runner_snap_proc_stat', 'runner_snap_proc_stat_cpu', 'runner_snap_proc_loadavg', 'runner_snap_proc_meminfo',
			'runner_snap_proc_psi', 'runner_snap_proc_netdev', 'runner_snap_proc_snmp', 'runner_snap_proc_thread', 'runner_snap_collector'
		]));
	});

	it('imports runner_snapshots + runner_config and reports a client-bound verdict', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'mybench-runner-e2e-'));
		const { db: dbModule, importer, telemetry } = await loadModules(dataDir);
		const db = dbModule.getDb();

		db.exec(`
			INSERT INTO decisions (id, name) VALUES (1, 'decision');
			INSERT INTO designs (id, decision_id, name, database) VALUES (1, 1, 'design', 'bench');
			INSERT INTO benchmark_runs (id, design_id, database) VALUES (1, 1, 'bench');
		`);

		const result = {
			run: {
				status: 'completed',
				started_at: ts(-5),
				finished_at: ts(20),
				bench_started_at: ts(0),
				post_started_at: ts(15)
			},
			runner_config: { nproc: 4, clk_tck: 100, mem_total_kb: 8000000, cpu_model: 'Test CPU', psi_available: true },
			runner_snapshots: {
				runner_snap_proc_stat: [
					{ _collected_at: ts(0), cpu_user: 0, cpu_nice: 0, cpu_system: 0, cpu_idle: 0, cpu_iowait: 0, cpu_irq: 0, cpu_softirq: 0, cpu_steal: 0, ctxt: 0, intr: 0, procs_running: 1, procs_blocked: 0 },
					{ _collected_at: ts(10), cpu_user: 1000, cpu_nice: 0, cpu_system: 0, cpu_idle: 3000, cpu_iowait: 0, cpu_irq: 0, cpu_softirq: 0, cpu_steal: 0, ctxt: 9000, intr: 100, procs_running: 5, procs_blocked: 1 }
				],
				runner_snap_proc_stat_cpu: [
					{ _collected_at: ts(0), cpu_id: '0', cpu_user: 0, cpu_idle: 0, cpu_nice: 0, cpu_system: 0, cpu_iowait: 0, cpu_irq: 0, cpu_softirq: 0, cpu_steal: 0 },
					{ _collected_at: ts(10), cpu_id: '0', cpu_user: 990, cpu_idle: 10, cpu_nice: 0, cpu_system: 0, cpu_iowait: 0, cpu_irq: 0, cpu_softirq: 0, cpu_steal: 0 },
					{ _collected_at: ts(0), cpu_id: '1', cpu_user: 0, cpu_idle: 0, cpu_nice: 0, cpu_system: 0, cpu_iowait: 0, cpu_irq: 0, cpu_softirq: 0, cpu_steal: 0 },
					{ _collected_at: ts(10), cpu_id: '1', cpu_user: 5, cpu_idle: 995, cpu_nice: 0, cpu_system: 0, cpu_iowait: 0, cpu_irq: 0, cpu_softirq: 0, cpu_steal: 0 }
				],
				runner_snap_proc_loadavg: [
					{ _collected_at: ts(0), load1: 0.25, load5: 0.1, load15: 0.05, running_threads: 2, total_threads: 300 },
					{ _collected_at: ts(10), load1: 1.5, load5: 0.4, load15: 0.1, running_threads: 3, total_threads: 300 }
				],
				runner_snap_proc_psi: [
					{ _collected_at: ts(0), cpu_some_avg10: 0.5, cpu_some_total: 0 },
					{ _collected_at: ts(10), cpu_some_avg10: 3.25, cpu_some_total: 1000 }
				],
				runner_snap_proc_snmp: [
					{ _collected_at: ts(0), tcp_retrans_segs: 0, tcp_out_segs: 0 },
					{ _collected_at: ts(10), tcp_retrans_segs: 1, tcp_out_segs: 100000 }
				],
				runner_snap_proc_thread: [
					thread(0, 700, 700, 'pgbench', 0, 0, 0),
					thread(10, 700, 700, 'pgbench', 970, 400_000_000, 20),
					thread(0, 600, 600, 'mybench-runner', 0, 0, 0),
					thread(10, 600, 600, 'mybench-runner', 12, 0, 1)
				],
				runner_snap_collector: [
					{ _collected_at: ts(0), sample_us: 150, threads: 2 },
					{ _collected_at: ts(10), sample_us: 170, threads: 2 }
				]
			}
		};
		importer.importResultIntoRun(1, result);

		// Column types: text discriminators stay TEXT, PSI/load stay REAL, counters INTEGER.
		const type = (table: string, col: string) =>
			(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).find((c) => c.name === col)?.type;
		expect(type('runner_snap_proc_thread', 'proc')).toBe('TEXT');
		expect(type('runner_snap_proc_thread', 'wait_time_ns')).toBe('INTEGER');
		expect(type('runner_snap_proc_psi', 'cpu_some_avg10')).toBe('REAL');
		expect(type('runner_snap_proc_loadavg', 'load1')).toBe('REAL');
		expect(type('runner_snap_proc_stat_cpu', 'cpu_id')).toBe('TEXT');

		const stored = db.prepare(`SELECT runner_config FROM benchmark_runs WHERE id = 1`).get() as { runner_config: string };
		expect(JSON.parse(stored.runner_config)).toMatchObject({ nproc: 4, cpu_model: 'Test CPU' });
		expect((db.prepare(`SELECT COUNT(*) AS n FROM runner_snap_proc_thread WHERE _run_id = 1`).get() as { n: number }).n).toBe(4);

		// Re-importing the same result must not duplicate rows.
		importer.importResultIntoRun(1, result);
		expect((db.prepare(`SELECT COUNT(*) AS n FROM runner_snap_proc_stat WHERE _run_id = 1`).get() as { n: number }).n).toBe(2);
		expect((db.prepare(`SELECT COUNT(*) AS n FROM runner_snap_proc_thread WHERE _run_id = 1`).get() as { n: number }).n).toBe(4);

		const section = telemetry.buildRunTelemetry(db, 1).sections.find((s) => s.key === 'runner_system');
		expect(section?.status).toBe('ok');
		const card = (key: string) => section?.summary.find((c) => c.key === key);
		expect(String(card('runner_verdict')?.value)).toMatch(/Client-bound/);
		expect(Number(card('runner_hottest_thread')?.value)).toBeCloseTo(0.97, 2);
		expect(Number(card('runner_busiest_core')?.value)).toBeCloseTo(0.99, 2);
		expect(Number(card('runner_cpu_avg')?.value)).toBeCloseTo(0.25, 2);
		expect(card('runner_nproc')?.value).toBe(4);
		const runQueue = section?.chartMetrics?.find((m) => m.key === 'run_queue');
		expect(runQueue?.series.find((x) => x.label === 'Running + runnable')?.points.map((p) => p.v)).toEqual([1, 5]);
		expect(runQueue?.series.find((x) => x.label === 'Blocked on I/O')?.points.map((p) => p.v)).toEqual([0, 1]);
		const keys = section?.chartMetrics?.map((m) => m.key) ?? [];
		expect(keys).toEqual(expect.arrayContaining([
			'thread_cpu_summary', 'cpu_pct', 'run_queue', 'cpu_cores_spread', 'cpu_per_core', 'load_vs_cores', 'psi', 'tcp_retrans', 'self_cpu', 'collector_sample'
		]));
	});
});
