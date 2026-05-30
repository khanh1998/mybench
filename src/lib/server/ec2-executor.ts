import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import getDb from '$lib/server/db';
import { createRun, completeRun, getActiveRun } from '$lib/server/run-manager';
import {
	connectSsh,
	exec,
	execStreamingCancellable,
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
	profile_source?: 'decision' | 'design';
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
			const outputFile = (evt.output_file as string) ?? '';
			setCurrentStepId(stepId);
			db.prepare(
				`UPDATE run_step_results SET status='running', started_at=?, output_file=? WHERE run_id=? AND step_id=?`
			).run(now, outputFile, runId, stepId);
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
		| { id: number; name: string; database: string; server_id: number | null; pre_collect_secs: number; post_collect_secs: number }
		| undefined;
	if (!design) throw new Error(`Design ${designId} not found`);
	const resolvedDatabase = opts.database ?? design.database;

	const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(Number(ec2ServerId)) as
		Ec2Server | undefined;
	if (!ec2Server) throw new Error(`EC2 server ${ec2ServerId} not found`);

	const resolvedPgServerId = opts.server_id ?? design.server_id;
	const pgServerSnap = resolvedPgServerId
		? db.prepare('SELECT spec, pg_config FROM pg_servers WHERE id = ?').get(resolvedPgServerId) as { spec: string; pg_config: string } | undefined
		: undefined;

	// Resolve profile name from decision or design profiles table
	let profileName = '';
	if (opts.profile_id) {
		const table = opts.profile_source === 'decision' ? 'decision_param_profiles' : 'design_param_profiles';
		const profile = db
			.prepare(`SELECT name FROM ${table} WHERE id = ?`)
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
			name, profile_name, ec2_server_id, ec2_run_token,
			runner_spec, db_spec, db_pg_config
		) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			ec2RunToken,
			ec2Server.spec ?? '',
			pgServerSnap?.spec ?? '',
			pgServerSnap?.pg_config ?? ''
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
	exec_log_path: string;
	host: string;
	user: string;
	port: number;
	private_key: string;
	remote_dir: string;
	log_dir: string;
	cli_log_dir: string;
}

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * After a recovered run resolves (completed or failed), close its parent series/suite
 * if all sibling runs have also resolved. Normal execution closes series/suites directly
 * in the executor; this is only needed for the startup recovery path.
 */
function propagateRunStatus(runId: number, db: ReturnType<typeof getDb>): void {
	const now = new Date().toISOString();
	const row = db.prepare('SELECT series_id FROM benchmark_runs WHERE id = ?').get(runId) as { series_id: number | null } | undefined;
	const seriesId = row?.series_id;
	if (!seriesId) return;

	const counts = db.prepare(`
		SELECT COUNT(*) AS total,
		       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS still_running,
		       SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
		FROM benchmark_runs WHERE series_id = ?
	`).get(seriesId) as { total: number; still_running: number; completed: number };

	if (counts.still_running > 0) return;

	const seriesStatus = counts.completed === counts.total ? 'completed' : 'failed';
	db.prepare(`UPDATE benchmark_series SET status=?, finished_at=? WHERE id=? AND status='running'`)
		.run(seriesStatus, now, seriesId);
	console.log(`[ec2-recovery] Series ${seriesId} → ${seriesStatus}`);

	const series = db.prepare('SELECT suite_id FROM benchmark_series WHERE id = ?').get(seriesId) as { suite_id: number | null } | undefined;
	const suiteId = series?.suite_id;
	if (!suiteId) return;

	const suiteCounts = db.prepare(`
		SELECT COUNT(*) AS total,
		       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS still_running,
		       SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
		FROM benchmark_series WHERE suite_id = ?
	`).get(suiteId) as { total: number; still_running: number; completed: number };

	if (suiteCounts.still_running > 0) return;

	const suiteStatus = suiteCounts.completed === suiteCounts.total ? 'completed' : 'failed';
	db.prepare(`UPDATE decision_suites SET status=?, finished_at=? WHERE id=? AND status='running'`)
		.run(suiteStatus, now, suiteId);
	console.log(`[ec2-recovery] Suite ${suiteId} → ${suiteStatus}`);
}

/**
 * Called at startup. For each benchmark_run that was still 'running' on an EC2 server,
 * checks whether mybench-runner has since finished (result file exists) or is still in
 * progress (pgrep finds the process), and recovers accordingly.
 */
export function recoverEc2Runs(): void {
	const db = getDb();

	const staleRuns = db.prepare(`
		SELECT br.id, br.ec2_run_token, br.ec2_server_id, br.exec_log_path,
		       e.host, e.user, e.port, e.private_key, e.remote_dir, e.log_dir, e.cli_log_dir
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
		cli_log_dir: run.cli_log_dir ?? '/tmp/gocli-logs',
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

		// If exec_log_path is set, replay events from it and wait for run_done
		if (run.exec_log_path) {
			console.log(`[ec2-recovery] Run ${run.id}: tailing exec log ${run.exec_log_path}`);
			let currentStepId: number | null = null;
			const { promise: tailPromise, cancel: stopTail } = execStreamingCancellable(
				conn,
				`timeout 86400 tail -n +1 -F ${shellQuote(run.exec_log_path)}`,
				(line) => {
					if (!line.startsWith(MB_PREFIX)) return;
					try {
						const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
						handleRunEvent(run.id, evt, db, (sid) => { currentStepId = sid; });
						if (evt.event === 'run_done') stopTail();
					} catch { /* ignore */ }
				}
			);
			await tailPromise;
			void currentStepId; // used via side-effect in handleRunEvent
		}

		const resultExists = (await exec(conn, `test -f ${shellQuote(remoteResultPath)} && echo yes || echo no`)).stdout.trim() === 'yes';

		if (resultExists) {
			console.log(`[ec2-recovery] Run ${run.id}: result file found, importing...`);
			await downloadFile(conn, remoteResultPath, localResultPath);
			conn.end(); conn = undefined;
			importResultIntoRun(run.id, JSON.parse(readFileSync(localResultPath, 'utf8')));
			propagateRunStatus(run.id, db);
			console.log(`[ec2-recovery] Run ${run.id}: recovered successfully`);
			return;
		}

		if (run.exec_log_path) {
			// exec log path was set — if we got here the run_done event arrived but no result file
			console.log(`[ec2-recovery] Run ${run.id}: run_done received but no result file — marking failed`);
			db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`)
				.run(new Date().toISOString(), run.id);
			propagateRunStatus(run.id, db);
			return;
		}

		// Legacy path (no exec_log_path): pgrep + poll
		const pgrepOut = (await exec(conn, `pgrep -f ${shellQuote(`result-${run.ec2_run_token}.json`)} || true`)).stdout.trim();
		conn.end(); conn = undefined;

		if (!pgrepOut) {
			console.log(`[ec2-recovery] Run ${run.id}: process dead, no result — marking failed`);
			db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`)
				.run(new Date().toISOString(), run.id);
			propagateRunStatus(run.id, db);
			return;
		}

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
				propagateRunStatus(run.id, db);
				console.log(`[ec2-recovery] Run ${run.id}: recovered successfully`);
				return;
			}

			// Check if the process is still alive (use result path — see note in recoverSingleEc2Run)
			const pgrepOut = (await exec(conn, `pgrep -f ${shellQuote(`result-${run.ec2_run_token}.json`)} || true`)).stdout.trim();
			conn.end(); conn = undefined;

			if (!pgrepOut) {
				console.log(`[ec2-recovery] Run ${run.id}: process exited without result — marking failed`);
				db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE id = ?`)
					.run(new Date().toISOString(), run.id);
				propagateRunStatus(run.id, db);
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
	propagateRunStatus(run.id, db);
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
	const sessionKey = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '_' + ec2RunToken.slice(0, 6);
	let conn: Client | undefined;
	let currentStepId: number | null = null;

	try {
		// Connect SSH
		emit(`Connecting to ${ec2Server.user}@${ec2Server.host}:${ec2Server.port}...`);
		conn = await connectSsh(ec2Server);

		// Resolve ~ to $HOME for SFTP (fastPut/fastGet don't expand tildes)
		const homeDir = (await exec(conn, 'echo $HOME')).stdout.trim();
		const remoteDir = ec2Server.remote_dir.replace(/^~/, homeDir);
		const remoteLogDir = ec2Server.log_dir.replace(/^~/, homeDir);
		const remoteCliLogDir = (ec2Server.cli_log_dir || '/tmp/gocli-logs').replace(/^~/, homeDir);

		// Exec log: structured events + progress lines written by CLI via file I/O (safe on SIGKILL)
		// Debug log: CLI stderr captured via shell redirect (Go warnings/errors for post-mortem)
		const execLogPath = `${remoteLogDir}/run_${sessionKey}.log`;
		const debugLogPath = `${remoteCliLogDir}/run_${sessionKey}.log`;

		// Ensure remote directories exist and store exec_log_path before launch
		await exec(conn, `mkdir -p ${shellQuote(remoteDir)} ${shellQuote(remoteLogDir)} ${shellQuote(remoteCliLogDir)}`);
		db.prepare(`UPDATE benchmark_runs SET exec_log_path=? WHERE id=?`).run(execLogPath, runId);

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

		// Build CLI command — runs in background, independent of this SSH session
		const binaryPath = `${remoteDir}/mybench-runner`;
		const remoteResultPath = `${remoteDir}/result-${ec2RunToken}.json`;
		const cmdParts = [
			'nohup',
			shellQuote(binaryPath),
			'run',
			'--json-events',
			'--exec-log', shellQuote(execLogPath),
			'--output', shellQuote(remoteResultPath),
			'--log-dir', shellQuote(remoteLogDir)
		];
		if (profileName) cmdParts.push('--profile', shellQuote(profileName));
		cmdParts.push(shellQuote(remotePlanPath));
		cmdParts.push('>/dev/null', `2>${shellQuote(debugLogPath)}`, '&');
		const launchCmd = cmdParts.join(' ');

		emit(`Launching mybench-runner on EC2...`);
		await exec(conn, launchCmd);

		// Wait for exec log to appear (CLI opens it immediately on start; up to 10s)
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const r = await exec(conn, `test -f ${shellQuote(execLogPath)} && echo y || echo n`);
			if (r.stdout.trim() === 'y') break;
			await new Promise((r) => setTimeout(r, 200));
		}

		// Tail exec log — drives DB updates + EventEmitter; cap lifetime at 24h to avoid orphans
		const { promise: tailPromise, cancel: stopTail } = execStreamingCancellable(
			conn,
			`timeout 86400 tail -n +1 -F ${shellQuote(execLogPath)}`,
			(line) => {
				if (line.startsWith(MB_PREFIX)) {
					try {
						const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
						handleRunEvent(runId, evt, db, (sid) => { currentStepId = sid; });
						if (evt.event === 'run_done') stopTail();
					} catch { /* malformed — ignore */ }
					return;
				}
				emit(line);
			}
		);
		await tailPromise;

		// Mark any still-pending/running steps as failed if the process failed
		const runRow = db.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId) as { status: string } | undefined;
		if (runRow?.status === 'failed') {
			db.prepare(
				`UPDATE run_step_results SET status='failed', finished_at=? WHERE run_id=? AND status IN ('pending','running')`
			).run(now(), runId);
		}

		// Reconnect after tail: forcibly closing the tail channel from within its onData callback
		// can leave the ssh2 connection in a state where subsequent exec() calls return empty stdout.
		// Retry up to 3 times with a short delay — SSH reconnect can occasionally return empty
		// stdout on the first exec after a forced channel close.
		conn.end();
		conn = undefined;

		let remoteResultExists = false;
		for (let attempt = 1; attempt <= 3; attempt++) {
			if (attempt > 1) await new Promise((r) => setTimeout(r, 2000 * attempt));
			try {
				conn?.end();
				conn = await connectSsh(ec2Server);
				const checkOut = (await exec(conn, `test -f ${shellQuote(remoteResultPath)} && echo yes || echo no`)).stdout.trim();
				if (checkOut === 'yes') { remoteResultExists = true; break; }
				if (checkOut === 'no') break; // definitive — file not there
				// Empty stdout — connection in bad state, retry
				console.warn(`[ec2-executor] Run ${runId}: empty stdout on result check (attempt ${attempt}), retrying...`);
			} catch (connErr) {
				console.warn(`[ec2-executor] Run ${runId}: SSH reconnect failed on attempt ${attempt}: ${connErr instanceof Error ? connErr.message : connErr}`);
			}
		}

		// Download and import result
		if (remoteResultExists) {
			emit(`Downloading result from EC2...`);
			await downloadFile(conn!, remoteResultPath, localResultPath);
			emit(`Importing result...`);
			importResultIntoRun(runId, JSON.parse(readFileSync(localResultPath, 'utf8')));
		} else {
			console.error(`[ec2-executor] Run ${runId}: result file not found at ${remoteResultPath} after run_done`);
			db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`).run(now(), runId);
			completeRun(runId);
			return;
		}

		db.prepare(`UPDATE benchmark_runs SET finished_at=COALESCE(finished_at, ?) WHERE id=?`).run(now(), runId);

		// NOTE: cleanup disabled for debugging — remote files kept on VPS
		// try {
		// 	await exec(conn, `rm -f ${shellQuote(remotePlanPath)} ${shellQuote(remoteResultPath)} && rm -rf ${shellQuote(remoteLogDir)}`);
		// } catch { /* ignore */ }

		emit(`\n=== EC2 benchmark completed ===`);
		completeRun(runId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[ec2-executor] Run ${runId} FATAL ERROR:`, err);
		emit(`[FATAL ERROR] ${msg}`);
		db.prepare(
			`UPDATE run_step_results SET status='failed', finished_at=? WHERE run_id=? AND status IN ('pending','running')`
		).run(now(), runId);
		db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`).run(now(), runId);
		completeRun(runId);
	} finally {
		conn?.end();
		try { unlinkSync(localPlanPath); } catch { /* ignore */ }
		try { unlinkSync(localResultPath); } catch { /* ignore */ }
	}
}
