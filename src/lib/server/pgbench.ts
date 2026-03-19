import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';

export interface PgbenchResult {
	tps: number | null;
	latencyAvgMs: number | null;
	latencyStddevMs: number | null;
	transactions: number | null;
	exitCode: number | null;
}

export interface PgbenchRunOptions {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	script: string;
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
		const scriptPath = join('/tmp', `mybench-${opts.runId}-${opts.stepId}.pgbench`);
		writeFileSync(scriptPath, opts.script, 'utf8');

		const args = [
			'-h', opts.host,
			'-p', String(opts.port),
			'-U', opts.user,
			'-d', opts.database,
			'-f', scriptPath,
			...parseOptions(opts.options)
		];

		const env = { ...process.env, PGPASSWORD: opts.password };
		const proc = spawn('pgbench', args, { env });

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
			try { if (existsSync(scriptPath)) unlinkSync(scriptPath); } catch {}
			resolve({
				...parsePgbenchOutput(stderrBuf + '\n'),
				exitCode: code
			});
		});

		// Attach proc to emitter so run-manager can kill it
		emitter.emit('process', proc);
	});
}

export function runSqlStep(
	pool: import('pg').Pool,
	script: string,
	emitter: EventEmitter,
	onLine: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<{ exitCode: number }> {
	return new Promise(async (resolve) => {
		try {
			// Split on semicolons (naive but workable for typical DDL/DML)
			const statements = script
				.split(';')
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			for (const stmt of statements) {
				onLine(`> ${stmt.slice(0, 80)}${stmt.length > 80 ? '…' : ''}`, 'stdout');
				emitter.emit('line', `> ${stmt.slice(0, 80)}${stmt.length > 80 ? '…' : ''}`);
				const result = await pool.query(stmt);
				const msg = `OK (${result.rowCount ?? 0} rows affected)`;
				onLine(msg, 'stdout');
				emitter.emit('line', msg);
			}
			resolve({ exitCode: 0 });
		} catch (err: unknown) {
			const msg = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
			onLine(msg, 'stderr');
			emitter.emit('line', '[stderr] ' + msg);
			resolve({ exitCode: 1 });
		}
	});
}

function parseOptions(opts: string): string[] {
	if (!opts.trim()) return [];
	// Simple shell-like split (doesn't handle quotes within quotes)
	return opts.trim().split(/\s+/);
}

function parsePgbenchOutput(output: string): Omit<PgbenchResult, 'exitCode'> {
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
