import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
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
	server_id?: number;
	database?: string;
	profile_id?: number;
	name?: string;
	snapshot_interval_seconds?: number;
	use_private_ip?: boolean;
}

const MB_PREFIX = '__MB__';

/**
 * Parses a __MB__-prefixed JSON event line from the Go CLI and routes it to the
 * appropriate SSE events and DB updates for a single run.
 */
function handleRunEvent(
	runId: number,
	evt: Record<string, unknown>,
	db: ReturnType<typeof getDb>,
	setCurrentStepId: (id: number) => void
): void {
	const now = new Date().toISOString();
	const activeRun = getActiveRun(runId);

	switch (evt.event) {
		case 'step_start': {
			const stepId = evt.step_id as number;
			setCurrentStepId(stepId);
			db.prepare(
				`UPDATE run_step_results SET status='running', started_at=? WHERE run_id=? AND step_id=?`
			).run(now, runId, stepId);
			activeRun?.emitter.emit('step', { step_id: stepId, status: 'running', started_at: now });
			break;
		}
		case 'step_done': {
			const stepId = evt.step_id as number;
			const status = (evt.status as string) === 'completed' ? 'completed' : 'failed';
			const exitCode = (evt.exit_code as number) ?? null;
			db.prepare(
				`UPDATE run_step_results SET status=?, exit_code=?, finished_at=? WHERE run_id=? AND step_id=?`
			).run(status, exitCode, now, runId, stepId);
			activeRun?.emitter.emit('step', { step_id: stepId, status, finished_at: now });
			break;
		}
		case 'phase': {
			activeRun?.emitter.emit('phase', {
				name: evt.name as string,
				status: evt.status as string,
				duration_secs: (evt.duration_secs as number) ?? 0,
				started_ms: Date.now()
			});
			break;
		}
		// run_done is handled by the existing result-import flow — no DB action needed here
	}
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
	const resolvedDatabase = opts.database ?? design.database;

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
			resolvedDatabase,
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

	// Pre-create real step result rows (one per enabled design step) so the UI
	// can render the step list immediately and update per-step status via SSE.
	const steps = db.prepare(
		'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
	).all(design.id) as { id: number; position: number; name: string; type: string }[];

	const insStep = db.prepare(
		`INSERT INTO run_step_results (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'pending')`
	);
	for (const step of steps) {
		insStep.run(runId, step.id, step.position, step.name, step.type);
	}

	// Register in-memory ActiveRun for SSE
	createRun(runId);

	// Fire and forget — errors handled inside
	executeEc2RunAsync(runId, design.id, ec2Server, profileName, ec2RunToken, opts).catch(() => {});

	return runId;
}

interface StaleEc2Run {
	id: number;
	ec2_run_token: string;
	ec2_server_id: number;
	host: string;
	user: string;
	port: number;
	private_key: string;
	remote_dir: string;
	log_dir: string;
}

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Called at startup. For each benchmark_run that was still 'running' on an EC2 server,
 * checks whether mybench-runner has since finished (result file exists) or is still in
 * progress (pgrep finds the process), and recovers accordingly.
 */
export function recoverEc2Runs(): void {
	const db = getDb();

	const staleRuns = db.prepare(`
		SELECT br.id, br.ec2_run_token, br.ec2_server_id,
		       e.host, e.user, e.port, e.private_key, e.remote_dir, e.log_dir
		FROM benchmark_runs br
		JOIN ec2_servers e ON br.ec2_server_id = e.id
		WHERE br.status = 'running'
		  AND br.ec2_run_token IS NOT NULL
		  AND br.ec2_server_id IS NOT NULL
	`).all() as StaleEc2Run[];

	if (staleRuns.length === 0) return;

	console.log(`[ec2-recovery] Found ${staleRuns.length} interrupted EC2 run(s), checking status...`);

	for (const run of staleRuns) {
		recoverSingleEc2Run(run).catch((err) => {
			console.error(`[ec2-recovery] Run ${run.id} recovery error: ${err instanceof Error ? err.message : err}`);
			db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`)
				.run(new Date().toISOString(), run.id);
		});
	}
}

async function recoverSingleEc2Run(run: StaleEc2Run): Promise<void> {
	const db = getDb();
	const ec2Server: import('$lib/types').Ec2Server = {
		id: run.ec2_server_id,
		name: '',
		host: run.host,
		user: run.user,
		port: run.port,
		private_key: run.private_key,
		remote_dir: run.remote_dir,
		log_dir: run.log_dir,
		vpc: ''
	};

	const localResultPath = `/tmp/mybench-ec2-result-${run.ec2_run_token}.json`;

	let conn: import('ssh2').Client | undefined;
	try {
		conn = await connectSsh(ec2Server);
		const homeDir = (await exec(conn, 'echo $HOME')).stdout.trim();
		const remoteDir = ec2Server.remote_dir.replace(/^~/, homeDir);
		const remoteResultPath = `${remoteDir}/result-${run.ec2_run_token}.json`;
		const remotePlanPath = `${remoteDir}/plan-${run.ec2_run_token}.json`;

		const resultExists = (await exec(conn, `test -f ${shellQuote(remoteResultPath)} && echo yes || echo no`)).stdout.trim() === 'yes';

		if (resultExists) {
			console.log(`[ec2-recovery] Run ${run.id}: result file found, importing...`);
			await downloadFile(conn, remoteResultPath, localResultPath);
			conn.end(); conn = undefined;
			importResultIntoRun(run.id, JSON.parse(readFileSync(localResultPath, 'utf8')));
			console.log(`[ec2-recovery] Run ${run.id}: recovered successfully`);
			return;
		}

		// Result not ready yet — check if mybench-runner is still alive
		const pgrepOut = (await exec(conn, `pgrep -f ${shellQuote(`plan-${run.ec2_run_token}.json`)} || true`)).stdout.trim();
		conn.end(); conn = undefined;

		if (!pgrepOut) {
			console.log(`[ec2-recovery] Run ${run.id}: process dead, no result — marking failed`);
			db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`)
				.run(new Date().toISOString(), run.id);
			return;
		}

		// Still running — poll until it finishes
		console.log(`[ec2-recovery] Run ${run.id}: mybench-runner still running (PID ${pgrepOut}), polling every ${POLL_INTERVAL_MS / 1000}s...`);
		await pollUntilDone(run, ec2Server, remoteResultPath, remotePlanPath, localResultPath);

	} finally {
		conn?.end();
		try { if (existsSync(localResultPath)) unlinkSync(localResultPath); } catch { /* ignore */ }
	}
}

async function pollUntilDone(
	run: StaleEc2Run,
	ec2Server: import('$lib/types').Ec2Server,
	remoteResultPath: string,
	remotePlanPath: string,
	localResultPath: string
): Promise<void> {
	const db = getDb();
	const deadline = Date.now() + POLL_TIMEOUT_MS;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

		let conn: import('ssh2').Client | undefined;
		try {
			conn = await connectSsh(ec2Server);

			const resultExists = (await exec(conn, `test -f ${shellQuote(remoteResultPath)} && echo yes || echo no`)).stdout.trim() === 'yes';

			if (resultExists) {
				console.log(`[ec2-recovery] Run ${run.id}: result ready, importing...`);
				await downloadFile(conn, remoteResultPath, localResultPath);
				conn.end(); conn = undefined;
				importResultIntoRun(run.id, JSON.parse(readFileSync(localResultPath, 'utf8')));
				console.log(`[ec2-recovery] Run ${run.id}: recovered successfully`);
				return;
			}

			// Check if the process is still alive
			const pgrepOut = (await exec(conn, `pgrep -f ${shellQuote(`plan-${run.ec2_run_token}.json`)} || true`)).stdout.trim();
			conn.end(); conn = undefined;

			if (!pgrepOut) {
				console.log(`[ec2-recovery] Run ${run.id}: process exited without result — marking failed`);
				db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`)
					.run(new Date().toISOString(), run.id);
				return;
			}

			console.log(`[ec2-recovery] Run ${run.id}: still in progress, next check in ${POLL_INTERVAL_MS / 1000}s`);
		} catch (sshErr) {
			console.warn(`[ec2-recovery] Run ${run.id}: SSH check failed (${sshErr instanceof Error ? sshErr.message : sshErr}), will retry`);
		} finally {
			conn?.end();
		}
	}

	// Exceeded 24-hour deadline
	console.error(`[ec2-recovery] Run ${run.id}: timed out after 24h — marking failed`);
	db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`)
		.run(new Date().toISOString(), run.id);
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
	let currentStepId: number | null = null;
	const LOG_CAP = 500_000;

	const flushStdout = () => {
		if (currentStepId !== null) {
			db.prepare(`UPDATE run_step_results SET stdout=? WHERE run_id=? AND step_id=?`)
				.run(stdoutAccum, runId, currentStepId);
		}
	};

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
			server_id: opts.server_id,
			database: opts.database,
			snapshot_interval_seconds: opts.snapshot_interval_seconds,
			use_private_ip: opts.use_private_ip
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
			'--json-events',
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

		let exitCode: number;
		try {
			exitCode = await execStreaming(conn, cmd, (line) => {
				// Intercept __MB__ structured events — never add them to the stored log
				if (line.startsWith(MB_PREFIX)) {
					try {
						const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
						handleRunEvent(runId, evt, db, (sid) => { currentStepId = sid; });
					} catch { /* malformed — ignore */ }
					return;
				}
				if (stdoutAccum.length < LOG_CAP) stdoutAccum += line + '\n';
				else if (!stdoutAccum.endsWith('[truncated]\n')) stdoutAccum += '[truncated]\n';
				emit(line);
				lineCount++;
				if (lineCount % 50 === 0) flushStdout();
			});
		} catch (sshErr) {
			// SSH connection dropped mid-run — try to reconnect and check if result already exists
			const sshMsg = sshErr instanceof Error ? sshErr.message : String(sshErr);
			emit(`[WARN] SSH connection lost: ${sshMsg}. Attempting recovery...`);
			flushStdout();
			try { conn.end(); } catch { /* ignore */ }
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

		// Mark any still-pending/running steps as failed if the process exited non-zero
		if (exitCode !== 0) {
			emit(`[ERROR] mybench-runner exited with code ${exitCode}`);
			db.prepare(
				`UPDATE run_step_results SET status='failed', finished_at=? WHERE run_id=? AND status IN ('pending','running')`
			).run(now(), runId);
		}

		// Always try to download and import the result — the runner writes result.json
		// even when a step fails, so we can show partial results and step logs in the UI.
		const remoteResultExists = (await exec(conn, `test -f ${shellQuote(remoteResultPath)} && echo yes || echo no`)).stdout.trim() === 'yes';
		if (remoteResultExists) {
			emit(`Downloading result from EC2...`);
			await downloadFile(conn, remoteResultPath, localResultPath);

			emit(`Importing result...`);
			const resultJson = JSON.parse(readFileSync(localResultPath, 'utf8'));
			importResultIntoRun(runId, resultJson);
		} else if (exitCode !== 0) {
			// No result file and non-zero exit — mark as failed now
			db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`).run(
				now(),
				runId
			);
			completeRun(runId);
			return;
		}

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
		flushStdout();
		db.prepare(
			`UPDATE run_step_results SET status='failed', finished_at=? WHERE run_id=? AND status IN ('pending','running')`
		).run(now(), runId);
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
