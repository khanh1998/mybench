import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { getRunnablePgbenchScripts } from '$lib/params';
import { parsePgbenchFinalOutput, type PgbenchScriptResult, type PgbenchStepSummary } from '$lib/pgbench-results';
import type { PgbenchScript } from '$lib/types';

export interface PgbenchResult {
	tps: number | null;
	latencyAvgMs: number | null;
	latencyStddevMs: number | null;
	transactions: number | null;
	failedTransactions: number | null;
	exitCode: number | null;
	command: string;
	pgbenchSummary: PgbenchStepSummary | null;
	pgbenchScripts: PgbenchScriptResult[];
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

		const userOptions = parseOptions(opts.options);
		const hasProgressFlag = userOptions.some((o) => o === '-P' || /^--progress(=.*)?$/.test(o));
		const progressArgs = hasProgressFlag ? [] : ['-P', '5'];

		const args = [
			'-h', opts.host,
			'-p', String(opts.port),
			'-U', opts.user,
			...fileArgs,
			...userOptions,
			...progressArgs,
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

		proc.on('error', (err) => {
			const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
				? `pgbench not found. Ensure PostgreSQL client tools are installed and on PATH.`
				: `Failed to spawn pgbench: ${err.message}`;
			emitter.emit('line', `[ERROR] ${msg}`);
			onLine(msg, 'stderr');
			for (const p of tempFiles) { try { if (existsSync(p)) unlinkSync(p); } catch {} }
			resolve({ tps: null, latencyAvgMs: null, latencyStddevMs: null, transactions: null, failedTransactions: null, exitCode: 1, command, pgbenchSummary: null, pgbenchScripts: [] });
		});

		proc.on('close', (code) => {
			if (stdoutBuf) { emitter.emit('line', stdoutBuf); onLine(stdoutBuf, 'stdout'); }
			if (stderrBuf) { emitter.emit('line', '[stderr] ' + stderrBuf); onLine(stderrBuf, 'stderr'); }
			for (const p of tempFiles) {
				try { if (existsSync(p)) unlinkSync(p); } catch {}
			}
			const parsed = parsePgbenchFinalOutput(fullStdout);
			resolve({
				tps: parsed.summary?.tps ?? null,
				latencyAvgMs: parsed.summary?.latency_avg_ms ?? null,
				latencyStddevMs: parsed.summary?.latency_stddev_ms ?? null,
				transactions: parsed.summary?.transactions ?? null,
				failedTransactions: parsed.summary?.failed_transactions ?? null,
				exitCode: code,
				command,
				pgbenchSummary: parsed.summary,
				pgbenchScripts: parsed.scripts
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
