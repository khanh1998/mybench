import { EventEmitter } from 'events';
import type { Client } from 'ssh2';
import { connectSsh, exec } from '$lib/server/ec2-runner';
import { getPgServer } from '$lib/server/services/pg-servers';
import type { PgServer } from '$lib/types';
import getDb from '$lib/server/db';

// ── Types ──────────────────────────────────────────────────────────────

export type PresetProfile = 'quick' | 'standard' | 'deep';
export type TestCategory = 'cpu' | 'memory' | 'wal_write' | 'checkpoint_write' | 'random_read' | 'sequential_read' | 'mixed_io';

export interface BenchmarkMetrics {
	events_per_sec?: number;
	iops?: number;
	reads_per_sec?: number;
	writes_per_sec?: number;
	fsyncs_per_sec?: number;
	throughput_read_mbps?: number;
	throughput_write_mbps?: number;
	latency_avg_ms?: number;
	latency_p95_ms?: number;
	latency_p99_ms?: number;
	total_time_secs?: number;
	total_events?: number;
}

export interface HardwareSpec {
	cpu_model: string;
	cpu_cores: number;
	ram_mb: number;
	storage_type: string;
	disk_size_gb: number;
	os_version: string;
	kernel_version: string;
}

export interface TestItem {
	category: TestCategory;
	threads: number;
	label: string;
	isFileio: boolean;
	writesFiles: boolean;
	command: string;
}

export interface SystemBenchmark {
	id: number;
	pg_server_id: number | null;
	pg_server_name: string;
	preset: string;
	status: string;
	cpu_model: string;
	cpu_cores: number;
	ram_mb: number;
	storage_type: string;
	disk_size_gb: number;
	os_version: string;
	kernel_version: string;
	error_message: string;
	created_at: string;
	finished_at: string | null;
}

export interface SystemBenchmarkResult {
	id: number;
	benchmark_id: number;
	test_category: string;
	threads: number;
	metrics_json: string;
	raw_output: string;
	duration_secs: number;
	exit_code: number;
	created_at: string;
}

const PRESET_CONFIG: Record<PresetProfile, { duration: number; fileSize: string }> = {
	quick: { duration: 10, fileSize: '2G' },
	standard: { duration: 40, fileSize: '4G' },
	deep: { duration: 100, fileSize: '8G' },
};

const CATEGORY_LABELS: Record<TestCategory, string> = {
	cpu: 'CPU',
	memory: 'Memory',
	wal_write: 'WAL Write',
	checkpoint_write: 'Checkpoint Write',
	random_read: 'Random Read',
	sequential_read: 'Sequential Read',
	mixed_io: 'Mixed OLTP I/O',
};

// ── Active benchmark tracking ──────────────────────────────────────────

const activeBenchmarks = new Map<number, { emitter: EventEmitter }>();

export function getActiveBenchmark(id: number) {
	return activeBenchmarks.get(id);
}

function cleanupBenchmark(id: number) {
	setTimeout(() => activeBenchmarks.delete(id), 60_000);
}

// ── SSH target builder ─────────────────────────────────────────────────

export function buildSshTarget(server: PgServer) {
	if (!server.ssh_enabled) throw new Error('SSH is not enabled for this server');
	if (!server.ssh_user) throw new Error('SSH user is required');
	if (!server.ssh_private_key) throw new Error('SSH private key is required');

	return {
		id: server.id,
		name: server.name,
		host: server.ssh_host || server.host,
		user: server.ssh_user,
		port: server.ssh_port,
		private_key: server.ssh_private_key,
		remote_dir: '',
		log_dir: '',
		cli_log_dir: '/tmp/gocli-logs',
		vpc: server.vpc
	};
}

// ── Hardware spec detection ────────────────────────────────────────────

export async function detectHardwareSpec(conn: Client): Promise<HardwareSpec> {
	const [cpuCoresRes, cpuModelRes, ramRes, diskRes, osRes, kernelRes] = await Promise.all([
		exec(conn, 'nproc'),
		exec(conn, "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/(R)//g; s/(TM)//g; s/  */ /g; s/^ //; s/ CPU//' | xargs"),
		exec(conn, "awk '/MemTotal/ {printf \"%.0f\", $2/1024}' /proc/meminfo"),
		exec(conn, [
			'ROOT_DEV=$(lsblk -no pkname $(findmnt -n -o SOURCE /) 2>/dev/null | head -1)',
			'DISC=$(cat /sys/block/$ROOT_DEV/queue/discard_granularity 2>/dev/null || echo 0)',
			'NVME=$(ls /dev/nvme0 2>/dev/null && echo 1 || echo 0)',
			'SIZE=$(lsblk -bdno SIZE /dev/$ROOT_DEV 2>/dev/null || echo 0)',
			'echo "$DISC $NVME $SIZE"'
		].join('\n')),
		exec(conn, "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"' || echo unknown"),
		exec(conn, 'uname -r'),
	]);

	const cpuCores = parseInt(cpuCoresRes.stdout.trim(), 10) || 0;
	const cpuModel = cpuModelRes.stdout.trim();
	const ramMb = parseInt(ramRes.stdout.trim(), 10) || 0;

	const [discStr, nvmeStr, sizeStr] = diskRes.stdout.trim().split(/\s+/);
	const isNvme = nvmeStr === '1';
	const isSsd = isNvme || parseInt(discStr ?? '0', 10) > 0;
	const diskBytes = parseInt(sizeStr ?? '0', 10) || 0;
	const diskSizeGb = diskBytes > 0 ? Math.round(diskBytes / (1024 ** 3)) : 0;
	const storageType = isNvme ? 'NVMe' : isSsd ? 'SSD' : 'HDD';

	return {
		cpu_model: cpuModel,
		cpu_cores: cpuCores,
		ram_mb: ramMb,
		storage_type: storageType,
		disk_size_gb: diskSizeGb,
		os_version: osRes.stdout.trim(),
		kernel_version: kernelRes.stdout.trim(),
	};
}

// ── Test plan builder ──────────────────────────────────────────────────

export function buildTestPlan(cpuCores: number, preset: PresetProfile): TestItem[] {
	const { duration: durationSecs, fileSize } = PRESET_CONFIG[preset];
	const threads = cpuCores > 1 ? cpuCores : 2;

	const categories: { category: TestCategory; isFileio: boolean; writesFiles: boolean; buildCmd: (t: number) => string }[] = [
		{
			category: 'cpu',
			isFileio: false, writesFiles: false,
			buildCmd: (t) => `sysbench cpu --threads=${t} --time=${durationSecs} --cpu-max-prime=20000 run`,
		},
		{
			category: 'memory',
			isFileio: false, writesFiles: false,
			buildCmd: (t) => `sysbench memory --threads=${t} --time=${durationSecs} --memory-block-size=1K --memory-total-size=100G --memory-oper=write --memory-access-mode=seq run`,
		},
		// Read tests first (don't corrupt prepared files)
		{
			category: 'random_read',
			isFileio: true, writesFiles: false,
			buildCmd: (t) => `sysbench fileio --threads=${t} --time=${durationSecs} --file-total-size=${fileSize} --file-test-mode=rndrd --file-block-size=8192 --file-extra-flags=direct run`,
		},
		{
			category: 'sequential_read',
			isFileio: true, writesFiles: false,
			buildCmd: (t) => `sysbench fileio --threads=${t} --time=${durationSecs} --file-total-size=${fileSize} --file-test-mode=seqrd --file-block-size=262144 --file-extra-flags=direct run`,
		},
		// Write tests last (corrupt files, need re-prepare between them)
		{
			category: 'wal_write',
			isFileio: true, writesFiles: true,
			buildCmd: (t) => `sysbench fileio --threads=${t} --time=${durationSecs} --file-total-size=${fileSize} --file-test-mode=seqwr --file-block-size=8192 --file-fsync-freq=1 --file-extra-flags=direct run`,
		},
		{
			category: 'checkpoint_write',
			isFileio: true, writesFiles: true,
			buildCmd: (t) => `sysbench fileio --threads=${t} --time=${durationSecs} --file-total-size=${fileSize} --file-test-mode=rndwr --file-block-size=8192 --file-fsync-freq=100 --file-extra-flags=direct run`,
		},
		{
			category: 'mixed_io',
			isFileio: true, writesFiles: true,
			buildCmd: (t) => `sysbench fileio --threads=${t} --time=${durationSecs} --file-total-size=${fileSize} --file-test-mode=rndrw --file-block-size=8192 --file-rw-ratio=2.33 --file-extra-flags=direct run`,
		},
	];

	const plan: TestItem[] = [];
	for (const cat of categories) {
		for (const t of [1, threads]) {
			plan.push({
				category: cat.category,
				threads: t,
				label: `${CATEGORY_LABELS[cat.category]} (${t} thread${t > 1 ? 's' : ''})`,
				isFileio: cat.isFileio,
				writesFiles: cat.writesFiles,
				command: cat.buildCmd(t),
			});
		}
	}
	return plan;
}

// ── Sysbench output parser ─────────────────────────────────────────────

export function parseSysbenchMetrics(output: string, category: TestCategory): BenchmarkMetrics {
	const metrics: BenchmarkMetrics = {};

	// Events per second (cpu, memory, threads, mutex)
	const epsMatch = output.match(/events per second:\s+([\d.]+)/i);
	if (epsMatch) metrics.events_per_sec = parseFloat(epsMatch[1]);

	// Total events
	const totalEventsMatch = output.match(/total number of events:\s+(\d+)/);
	if (totalEventsMatch) metrics.total_events = parseInt(totalEventsMatch[1], 10);

	// Total time
	const totalTimeMatch = output.match(/total time:\s+([\d.]+)s/);
	if (totalTimeMatch) metrics.total_time_secs = parseFloat(totalTimeMatch[1]);

	// Fileio-specific: reads/s, writes/s, fsyncs/s
	const readsMatch = output.match(/reads\/s:\s+([\d.]+)/);
	if (readsMatch) metrics.reads_per_sec = parseFloat(readsMatch[1]);

	const writesMatch = output.match(/writes\/s:\s+([\d.]+)/);
	if (writesMatch) metrics.writes_per_sec = parseFloat(writesMatch[1]);

	const fsyncsMatch = output.match(/fsyncs\/s:\s+([\d.]+)/);
	if (fsyncsMatch) metrics.fsyncs_per_sec = parseFloat(fsyncsMatch[1]);

	// Compute IOPS from reads + writes
	if (metrics.reads_per_sec != null || metrics.writes_per_sec != null) {
		metrics.iops = (metrics.reads_per_sec ?? 0) + (metrics.writes_per_sec ?? 0);
	}

	// Throughput
	const readThroughput = output.match(/read, MiB\/s:\s+([\d.]+)/);
	if (readThroughput) metrics.throughput_read_mbps = parseFloat(readThroughput[1]);

	const writeThroughput = output.match(/written, MiB\/s:\s+([\d.]+)/);
	if (writeThroughput) metrics.throughput_write_mbps = parseFloat(writeThroughput[1]);

	// Latency
	const avgMatch = output.match(/avg:\s+([\d.]+)/);
	if (avgMatch) metrics.latency_avg_ms = parseFloat(avgMatch[1]);

	const p95Match = output.match(/95th percentile:\s+([\d.]+)/);
	if (p95Match) {
		const v = parseFloat(p95Match[1]);
		if (v > 0) metrics.latency_p95_ms = v;
	}

	const p99Match = output.match(/99th percentile:\s+([\d.]+)/);
	if (p99Match) {
		const v = parseFloat(p99Match[1]);
		if (v > 0) metrics.latency_p99_ms = v;
	}

	// For memory test: MiB/sec is the key metric
	if (category === 'memory') {
		const mibMatch = output.match(/([\d.]+)\s+MiB\/sec/);
		if (mibMatch) metrics.throughput_write_mbps = parseFloat(mibMatch[1]);
	}

	return metrics;
}

// ── Fileio helpers ─────────────────────────────────────────────────────

function combineOutput(stdout: string, stderr: string): string {
	return stderr
		? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}${stderr}`
		: stdout;
}

async function fileioSetup(conn: Client, tmpDir: string, fileSize: string): Promise<void> {
	await exec(conn, `mkdir -p ${tmpDir}`);
	await exec(conn, `cd ${tmpDir} && sysbench fileio --file-total-size=${fileSize} prepare`);
}

async function fileioCleanup(conn: Client, tmpDir: string): Promise<void> {
	await exec(conn, `rm -rf ${tmpDir}`);
}

async function runFileioTest(conn: Client, tmpDir: string, command: string, fileSize: string, needsReprepare: boolean): Promise<{ output: string; exitCode: number }> {
	// Write tests corrupt prepared files — re-prepare before running
	if (needsReprepare) {
		await exec(conn, `cd ${tmpDir} && sysbench fileio --file-total-size=${fileSize} cleanup 2>/dev/null; sysbench fileio --file-total-size=${fileSize} prepare`);
	}
	const result = await exec(conn, `cd ${tmpDir} && ${command}`);
	return {
		output: `$ ${command}\n${combineOutput(result.stdout, result.stderr).trimEnd()}`,
		exitCode: result.code,
	};
}

// ── Main orchestrator ──────────────────────────────────────────────────

export function startPresetBenchmark(pgServerId: number, preset: PresetProfile): { id: number; emitter: EventEmitter } {
	const db = getDb();
	const server = getPgServer(pgServerId);
	if (!server) throw new Error(`PostgreSQL server ${pgServerId} not found`);

	const sshTarget = buildSshTarget(server);
	const emitter = new EventEmitter();

	const row = db.prepare(`
		INSERT INTO system_benchmarks (pg_server_id, pg_server_name, preset, status)
		VALUES (?, ?, ?, 'running')
	`).run(pgServerId, server.name, preset);
	const benchmarkId = Number(row.lastInsertRowid);

	activeBenchmarks.set(benchmarkId, { emitter });

	runPresetBenchmarkAsync(benchmarkId, sshTarget, preset, emitter).catch(() => {});

	return { id: benchmarkId, emitter };
}

async function runPresetBenchmarkAsync(
	benchmarkId: number,
	sshTarget: ReturnType<typeof buildSshTarget>,
	preset: PresetProfile,
	emitter: EventEmitter
) {
	const db = getDb();
	let conn: Client | undefined;

	try {
		conn = await connectSsh(sshTarget);

		// Detect hardware
		const spec = await detectHardwareSpec(conn);
		db.prepare(`
			UPDATE system_benchmarks
			SET cpu_model = ?, cpu_cores = ?, ram_mb = ?, storage_type = ?,
			    disk_size_gb = ?, os_version = ?, kernel_version = ?
			WHERE id = ?
		`).run(spec.cpu_model, spec.cpu_cores, spec.ram_mb, spec.storage_type,
			spec.disk_size_gb, spec.os_version, spec.kernel_version, benchmarkId);

		emitter.emit('spec', spec);

		// Build and execute test plan
		const config = PRESET_CONFIG[preset];
		const plan = buildTestPlan(spec.cpu_cores, preset);
		const total = plan.length;
		const hasFileio = plan.some(t => t.isFileio);
		const fileioTmpDir = `/tmp/sysbench-preset-${Date.now()}`;

		// Prepare fileio files once
		if (hasFileio) {
			emitter.emit('test_start', {
				index: -1, total, category: 'fileio_prepare' as TestCategory,
				threads: 0, label: `Preparing ${config.fileSize} test files...`,
			});
			await fileioSetup(conn, fileioTmpDir, config.fileSize);
		}

		try {
			let filesCorrupted = false;
			for (let i = 0; i < plan.length; i++) {
				const test = plan[i];
				emitter.emit('test_start', {
					index: i, total, category: test.category,
					threads: test.threads, label: test.label,
				});

				let output: string;
				let exitCode: number;

				if (test.isFileio) {
					const needsReprepare = filesCorrupted;
					const result = await runFileioTest(conn, fileioTmpDir, test.command, config.fileSize, needsReprepare);
					output = result.output;
					exitCode = result.exitCode;
					if (test.writesFiles) filesCorrupted = true;
				} else {
					const result = await exec(conn, test.command);
					output = combineOutput(result.stdout, result.stderr);
					exitCode = result.code;
				}

				const metrics = parseSysbenchMetrics(output, test.category);

				db.prepare(`
					INSERT INTO system_benchmark_results (benchmark_id, test_category, threads, metrics_json, raw_output, duration_secs, exit_code)
					VALUES (?, ?, ?, ?, ?, ?, ?)
				`).run(benchmarkId, test.category, test.threads, JSON.stringify(metrics), output, config.duration, exitCode);

				emitter.emit('test_done', {
					index: i, total, category: test.category,
					threads: test.threads, label: test.label, metrics, exitCode,
				});
			}
		} finally {
			if (hasFileio) {
				await fileioCleanup(conn, fileioTmpDir);
			}
		}

		db.prepare(`UPDATE system_benchmarks SET status = 'completed', finished_at = datetime('now') WHERE id = ?`)
			.run(benchmarkId);
		emitter.emit('benchmark_done', { benchmarkId, status: 'completed' });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		db.prepare(`UPDATE system_benchmarks SET status = 'failed', error_message = ?, finished_at = datetime('now') WHERE id = ?`)
			.run(msg, benchmarkId);
		emitter.emit('benchmark_done', { benchmarkId, status: 'failed', error: msg });
	} finally {
		conn?.end();
		cleanupBenchmark(benchmarkId);
	}
}
