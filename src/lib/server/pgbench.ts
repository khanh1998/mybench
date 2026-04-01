import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { getRunnablePgbenchScripts } from '$lib/params';
import type { PgbenchScript } from '$lib/types';

export interface PgbenchResult {
	tps: number | null;
	latencyAvgMs: number | null;
	latencyStddevMs: number | null;
	transactions: number | null;
	exitCode: number | null;
	command: string;
}

export interface PgbenchRunOptions {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	scripts: PgbenchScript[];
	options: string; // extra pgbench flags e.g. "-c 10 -T 60"
	runId: number;
	stepId: number;
}

export function runPgbench(
	opts: PgbenchRunOptions,
	emitter: EventEmitter,
	onLine: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<PgbenchResult> {
	return new Promise((resolve) => {
		const tempFiles: string[] = [];
		const fileArgs: string[] = [];
		for (const s of getRunnablePgbenchScripts(opts.scripts)) {
			const p = join('/tmp', `mybench-${opts.runId}-${opts.stepId}-${s.id}.pgbench`);
			writeFileSync(p, s.script, 'utf8');
			tempFiles.push(p);
			fileArgs.push('-f', `${p}@${s.weight}`);
		}

		const args = [
			'-h', opts.host,
			'-p', String(opts.port),
			'-U', opts.user,
			...fileArgs,
			...parseOptions(opts.options),
			opts.database
		];

		const command = `pgbench ${args.join(' ')}`;
		const env = { ...process.env, PGPASSWORD: opts.password };
		const proc = spawn('pgbench', args, { env });

		let stdoutBuf = '';
		let fullStdout = '';
		let stderrBuf = '';
		let fullStderr = '';

		proc.stdout.on('data', (chunk: Buffer) => {
			const sout = chunk.toString();
			fullStdout += sout;
			stdoutBuf += sout;
			const lines = stdoutBuf.split('\n');
			stdoutBuf = lines.pop() ?? '';
			for (const line of lines) {
				emitter.emit('line', line);
				onLine(line, 'stdout');
			}
		});

		proc.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			fullStderr += text;
			stderrBuf += text;
			const lines = stderrBuf.split('\n');
			stderrBuf = lines.pop() ?? '';
			for (const line of lines) {
				emitter.emit('line', '[stderr] ' + line);
				onLine(line, 'stderr');
			}
		});

		proc.on('close', (code) => {
			if (stdoutBuf) { emitter.emit('line', stdoutBuf); onLine(stdoutBuf, 'stdout'); }
			if (stderrBuf) { emitter.emit('line', '[stderr] ' + stderrBuf); onLine(stderrBuf, 'stderr'); }
			for (const p of tempFiles) {
				try { if (existsSync(p)) unlinkSync(p); } catch {}
			}
			resolve({
				...parsePgbenchOutput(fullStdout),
				exitCode: code,
				command
			});
		});

		// Attach proc to emitter so run-manager can kill it
		emitter.emit('process', proc);
	});
}

export interface SqlStepOptions {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

export function runSqlStep(
	opts: SqlStepOptions,
	script: string,
	emitter: EventEmitter,
	onLine: (line: string, stream: 'stdout' | 'stderr') => void,
	noTransaction = false
): Promise<{ exitCode: number; command: string }> {
	return new Promise((resolve) => {
		const tmpFile = join('/tmp', `mybench-sql-${opts.database}-${Date.now()}.sql`);
		writeFileSync(tmpFile, script, 'utf8');

		const args = [
			'-h', opts.host,
			'-p', String(opts.port),
			'-U', opts.user,
			'-d', opts.database,
			'-v', 'ON_ERROR_STOP=1',   // exit non-zero on first SQL error
			...(noTransaction ? [] : ['--single-transaction']),
			'--no-psqlrc',             // ignore user's ~/.psqlrc
			'-f', tmpFile
		];
		const command = `psql ${args.join(' ')}`;

		const env = { ...process.env, PGPASSWORD: opts.password };
		const proc = spawn('psql', args, { env });

		let stdoutBuf = '';
		let stderrBuf = '';

		proc.stdout.on('data', (chunk: Buffer) => {
			stdoutBuf += chunk.toString();
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

		proc.on('close', (code) => {
			if (stdoutBuf) { emitter.emit('line', stdoutBuf); onLine(stdoutBuf, 'stdout'); }
			if (stderrBuf) { emitter.emit('line', '[stderr] ' + stderrBuf); onLine(stderrBuf, 'stderr'); }
			try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
			resolve({ exitCode: code ?? 1, command });
		});
	});
}

function parseOptions(opts: string): string[] {
	if (!opts.trim()) return [];
	// Simple shell-like split (doesn't handle quotes within quotes)
	return opts.trim().split(/\s+/);
}

function parsePgbenchOutput(output: string): Omit<PgbenchResult, 'exitCode' | 'command'> {
	// pgbench outputs like:
	// tps = 1234.56 (without initial connection establishment)
	// latency average = 0.810 ms
	// latency stddev = 0.123 ms
	// number of transactions actually processed: 75000
	const tpsMatch = output.match(/^tps\s*=\s*([\d.]+)/m);
	const latAvgMatch = output.match(/latency average\s*=\s*([\d.]+)\s*ms/m);
	const latStdMatch = output.match(/latency stddev\s*=\s*([\d.]+)\s*ms/m);
	const txnMatch = output.match(/number of transactions actually processed:\s*(\d+)/m);

	return {
		tps: tpsMatch ? parseFloat(tpsMatch[1]) : null,
		latencyAvgMs: latAvgMatch ? parseFloat(latAvgMatch[1]) : null,
		latencyStddevMs: latStdMatch ? parseFloat(latStdMatch[1]) : null,
		transactions: txnMatch ? parseInt(txnMatch[1]) : null
	};
}
