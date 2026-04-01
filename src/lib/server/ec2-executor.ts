import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import getDb from '$lib/server/db';
import { createRun, completeRun, getActiveRun } from '$lib/server/run-manager';
import {
	connectSsh,
	exec,
	execStreaming,
	uploadFile,
	downloadFile,
	shellQuote
} from '$lib/server/ec2-runner';
import { generatePlan } from '$lib/server/plan-generator';
import { importResultIntoRun } from '$lib/server/run-importer';
import type { Ec2Server } from '$lib/types';
import type { Client } from 'ssh2';

export interface StartEc2RunOptions {
	profile_id?: number;
	name?: string;
	snapshot_interval_seconds?: number;
}

/**
 * Creates a benchmark_runs row, registers an ActiveRun for SSE streaming,
 * and kicks off async EC2 execution. Returns the run_id immediately.
 */
export function startEc2Run(
	designId: number,
	ec2ServerId: number,
	opts: StartEc2RunOptions = {}
): number {
	const db = getDb();

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(designId)) as
		| { id: number; name: string; database: string; pre_collect_secs: number; post_collect_secs: number }
		| undefined;
	if (!design) throw new Error(`Design ${designId} not found`);

	const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(Number(ec2ServerId)) as
		Ec2Server | undefined;
	if (!ec2Server) throw new Error(`EC2 server ${ec2ServerId} not found`);

	// Resolve profile name
	let profileName = '';
	if (opts.profile_id) {
		const profile = db
			.prepare('SELECT name FROM design_param_profiles WHERE id = ?')
			.get(opts.profile_id) as { name: string } | undefined;
		if (profile) profileName = profile.name;
	}

	const runName = opts.name ?? profileName;
	const now = new Date().toISOString();
	// Unique token for this EC2 execution — used as the remote file stem so result files
	// are unambiguous even across multiple runs on the same EC2 server.
	const ec2RunToken = randomUUID();

	// Insert the benchmark_runs row
	const insertResult = db
		.prepare(`
		INSERT INTO benchmark_runs (
			design_id, database, status, started_at,
			snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
			name, profile_name, ec2_server_id, ec2_run_token
		) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
	`)
		.run(
			design.id,
			design.database,
			now,
			opts.snapshot_interval_seconds ?? 30,
			design.pre_collect_secs,
			design.post_collect_secs,
			runName,
			profileName,
			ec2ServerId,
			ec2RunToken
		);

	const runId = insertResult.lastInsertRowid as number;

	// Create a placeholder step result for live streaming
	db.prepare(`
		INSERT INTO run_step_results (run_id, step_id, position, name, type, status, started_at)
		VALUES (?, 0, 0, 'EC2 Remote Execution', 'sql', 'running', ?)
	`).run(runId, now);

	// Register in-memory ActiveRun for SSE
	createRun(runId);

	// Fire and forget — errors handled inside
	executeEc2RunAsync(runId, design.id, ec2Server, profileName, ec2RunToken, opts).catch(() => {
		// Swallow — errors are logged and DB updated inside executeEc2RunAsync
	});

	return runId;
}

async function executeEc2RunAsync(
	runId: number,
	designId: number,
	ec2Server: Ec2Server,
	profileName: string,
	ec2RunToken: string,
	opts: StartEc2RunOptions
): Promise<void> {
	const db = getDb();

	function emit(line: string) {
		getActiveRun(runId)?.emitter.emit('line', line);
	}

	const now = () => new Date().toISOString();
	const localPlanPath = `/tmp/mybench-ec2-plan-${ec2RunToken}.json`;
	const localResultPath = `/tmp/mybench-ec2-result-${ec2RunToken}.json`;
	let conn: Client | undefined;
	let remoteDir = ec2Server.remote_dir;
	let remoteLogDir = ec2Server.log_dir;
	let stdoutAccum = '';
	const LOG_CAP = 500_000;

	try {
		// Connect SSH
		emit(`Connecting to ${ec2Server.user}@${ec2Server.host}:${ec2Server.port}...`);
		conn = await connectSsh(ec2Server);

		// Resolve ~ to $HOME for SFTP (fastPut/fastGet don't expand tildes)
		const homeResult = await exec(conn, 'echo $HOME');
		const homeDir = homeResult.stdout.trim();
		remoteDir = ec2Server.remote_dir.replace(/^~/, homeDir);
		remoteLogDir = ec2Server.log_dir.replace(/^~/, homeDir);

		// Ensure remote directory exists
		await exec(conn, `mkdir -p ${shellQuote(remoteDir)}`);

		// Generate plan JSON and upload
		const plan = generatePlan(designId, {
			snapshot_interval_seconds: opts.snapshot_interval_seconds
		});
		writeFileSync(localPlanPath, JSON.stringify(plan));

		emit(`Uploading plan to ${ec2Server.host}...`);
		const remotePlanPath = `${remoteDir}/plan-${ec2RunToken}.json`;
		await uploadFile(conn, localPlanPath, remotePlanPath);

		// Build CLI command
		const binaryPath = `${remoteDir}/mybench-runner`;
		const remoteResultPath = `${remoteDir}/result-${ec2RunToken}.json`;
		const cmdParts = [
			shellQuote(binaryPath),
			'run',
			'--output',
			shellQuote(remoteResultPath),
			'--log-dir',
			shellQuote(remoteLogDir)
		];
		if (profileName) {
			cmdParts.push('--profile', shellQuote(profileName));
		}
		cmdParts.push(shellQuote(remotePlanPath));
		const cmd = cmdParts.join(' ');

		// Execute remotely with live output streaming
		emit(`Running mybench-runner on EC2...`);
		let lineCount = 0;
		const flushStdout = () => {
			db.prepare(`UPDATE run_step_results SET stdout = ? WHERE run_id = ? AND position = 0`)
				.run(stdoutAccum, runId);
		};

		let exitCode: number;
		try {
			exitCode = await execStreaming(conn, cmd, (line) => {
				if (stdoutAccum.length < LOG_CAP) stdoutAccum += line + '\n';
				emit(line);
				lineCount++;
				if (lineCount % 50 === 0) flushStdout();
			});
		} catch (sshErr) {
			// SSH connection dropped mid-run — try to reconnect and check if result already exists
			const sshMsg = sshErr instanceof Error ? sshErr.message : String(sshErr);
			emit(`[WARN] SSH connection lost: ${sshMsg}. Attempting recovery...`);
			flushStdout();
			try {
				conn.end();
			} catch { /* ignore */ }
			conn = await connectSsh(ec2Server);
			const checkResult = await exec(conn, `test -f ${shellQuote(remoteResultPath)} && echo exists`);
			if (checkResult.stdout.trim() === 'exists') {
				emit(`Result file found on EC2 — mybench-runner completed before connection dropped. Downloading...`);
				exitCode = 0;
			} else {
				throw new Error(`SSH connection dropped and mybench-runner did not produce a result file`);
			}
		}

		// Final flush of accumulated output
		flushStdout();

		// Update placeholder step with accumulated output
		db.prepare(`
			UPDATE run_step_results
			SET status = ?, exit_code = ?, stdout = ?, finished_at = ?
			WHERE run_id = ? AND position = 0
		`).run(exitCode === 0 ? 'completed' : 'failed', exitCode, stdoutAccum, now(), runId);

		if (exitCode !== 0) {
			emit(`[ERROR] mybench-runner exited with code ${exitCode}`);
			db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`).run(
				now(),
				runId
			);
			completeRun(runId);
			return;
		}

		// Download and import result
		emit(`Downloading result from EC2...`);
		await downloadFile(conn, remoteResultPath, localResultPath);

		emit(`Importing result...`);
		const resultJson = JSON.parse(readFileSync(localResultPath, 'utf8'));
		importResultIntoRun(runId, resultJson);

		// Ensure finished_at is set (importResultIntoRun writes the value from the result JSON,
		// but if it's missing for any reason, fall back to now)
		db.prepare(`
			UPDATE benchmark_runs SET finished_at = COALESCE(finished_at, ?) WHERE id = ?
		`).run(now(), runId);

		// Clean up remote files — best-effort, don't fail the run if this errors
		try {
			await exec(
				conn,
				`rm -f ${shellQuote(remotePlanPath)} ${shellQuote(remoteResultPath)} && rm -rf ${shellQuote(remoteLogDir)}`
			);
		} catch { /* ignore */ }

		emit(`\n=== EC2 benchmark completed ===`);
		completeRun(runId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emit(`[FATAL ERROR] ${msg}`);
		db.prepare(`
			UPDATE run_step_results
			SET status = 'failed', finished_at = ?, stdout = ?
			WHERE run_id = ? AND position = 0
		`).run(now(), stdoutAccum, runId);
		db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`).run(
			now(),
			runId
		);
		completeRun(runId);
	} finally {
		conn?.end();
		try { unlinkSync(localPlanPath); } catch { /* ignore */ }
		try { unlinkSync(localResultPath); } catch { /* ignore */ }
	}
}
