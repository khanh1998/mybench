import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { parseSysbenchFinalOutput, type SysbenchSummary } from '$lib/sysbench-results';

export interface SysbenchResult {
	tps: number | null;
	latencyAvgMs: number | null;
	latencyP95Ms: number | null;
	transactions: number | null;
	errors: number | null;
	exitCode: number | null;
	command: string;
	sysbenchSummary: SysbenchSummary | null;
}

export interface SysbenchRunOptions {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	script: string;
	options: string;
	runId: number;
	stepId: number;
}

function parseOptions(opts: string): string[] {
	if (!opts.trim()) return [];
	return opts.trim().split(/\s+/);
}

export function runSysbench(
	opts: SysbenchRunOptions,
	emitter: EventEmitter,
	onLine: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<SysbenchResult> {
	return new Promise((resolve) => {
		const luaFile = join('/tmp', `mybench-${opts.runId}-${opts.stepId}.lua`);
		writeFileSync(luaFile, opts.script, 'utf8');

		const userOptions = parseOptions(opts.options);
		const hasReportInterval = userOptions.some(o => o.startsWith('--report-interval'));
		const progressArgs = hasReportInterval ? [] : ['--report-interval=5'];

		const connArgs = [
			'--db-driver=pgsql',
			`--pgsql-host=${opts.host}`,
			`--pgsql-port=${opts.port}`,
			`--pgsql-user=${opts.user}`,
			`--pgsql-password=${opts.password}`,
			`--pgsql-db=${opts.database}`,
		];

		const args = [
			...connArgs,
			...userOptions,
			...progressArgs,
			luaFile,
			'run',
		];

		// Display command with masked password
		const displayArgs = [
			'--db-driver=pgsql',
			`--pgsql-host=${opts.host}`,
			`--pgsql-port=${opts.port}`,
			`--pgsql-user=${opts.user}`,
			`--pgsql-password=***`,
			`--pgsql-db=${opts.database}`,
			...userOptions,
			...progressArgs,
			luaFile,
			'run',
		];
		const command = `sysbench ${displayArgs.join(' ')}`;

		const proc = spawn('sysbench', args);

		let stdoutBuf = '';
		let fullStdout = '';
		let stderrBuf = '';

		proc.stdout.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			fullStdout += text;
			stdoutBuf += text;
			const lines = stdoutBuf.split('\n');
			stdoutBuf = lines.pop() ?? '';
			for (const line of lines) {
				emitter.emit('line', line);
				onLine(line, 'stdout');
			}
		});

		proc.stderr.on('data', (chunk: Buffer) => {
			stderrBuf += chunk.toString();
			const lines = stderrBuf.split('\n');
			stderrBuf = lines.pop() ?? '';
			for (const line of lines) {
				emitter.emit('line', '[stderr] ' + line);
				onLine(line, 'stderr');
			}
		});

		proc.on('error', (err) => {
			const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
				? `sysbench not found. Install it (e.g. brew install sysbench) and ensure it is on PATH.`
				: `Failed to spawn sysbench: ${err.message}`;
			emitter.emit('line', `[ERROR] ${msg}`);
			onLine(msg, 'stderr');
			try { if (existsSync(luaFile)) unlinkSync(luaFile); } catch {}
			resolve({ tps: null, latencyAvgMs: null, latencyP95Ms: null, transactions: null, errors: null, exitCode: 1, command, sysbenchSummary: null });
		});

		proc.on('close', (code) => {
			if (stdoutBuf) {
				fullStdout += stdoutBuf;
				emitter.emit('line', stdoutBuf);
				onLine(stdoutBuf, 'stdout');
			}
			if (stderrBuf) {
				emitter.emit('line', '[stderr] ' + stderrBuf);
				onLine(stderrBuf, 'stderr');
			}
			try { if (existsSync(luaFile)) unlinkSync(luaFile); } catch {}

			const summary = parseSysbenchFinalOutput(fullStdout);
			const hasData = Object.values(summary).some(v => v !== null);

			resolve({
				tps: summary.tps,
				latencyAvgMs: summary.latency_avg_ms,
				latencyP95Ms: summary.latency_p95_ms,
				transactions: summary.transactions,
				errors: summary.errors,
				exitCode: code,
				command,
				sysbenchSummary: hasData ? summary : null,
			});
		});

		emitter.emit('process', proc);
	});
}
