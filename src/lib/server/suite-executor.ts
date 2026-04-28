import { EventEmitter } from 'events';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import getDb from '$lib/server/db';
import { startSeries, getActiveSeries } from '$lib/server/series-executor';
import {
	connectSsh,
	execStreaming,
	uploadFile,
	downloadFile,
	exec,
	shellQuote
} from '$lib/server/ec2-runner';
import { generatePlan } from '$lib/server/plan-generator';
import { importResultIntoRun } from '$lib/server/run-importer';
import type { Ec2Server } from '$lib/types';

export interface SuiteDesignConfig {
	design_id: number;
	profile_ids: number[];  // ordered
}

export interface StartSuiteOptions {
	decision_id: number;
	designs: SuiteDesignConfig[];
	delay_seconds: number;
	name?: string;
	ec2_server_id?: number | null;
	server_id?: number;
	database?: string;
	snapshot_interval_seconds?: number;
	use_private_ip?: boolean;
}

export interface SuiteEmitter extends EventEmitter {
	emit(event: 'line', line: string): boolean;
	emit(event: 'series-done', data: { series_id: number; design_id: number; index: number }): boolean;
	emit(event: 'done'): boolean;
	on(event: 'line', listener: (line: string) => void): this;
	on(event: 'series-done', listener: (data: { series_id: number; design_id: number; index: number }) => void): this;
	on(event: 'done', listener: () => void): this;
}

const activeSuites = new Map<number, SuiteEmitter>();

export function getActiveSuite(suiteId: number): SuiteEmitter | undefined {
	return activeSuites.get(suiteId);
}

export function startSuite(opts: StartSuiteOptions): number {
	const db = getDb();

	if (opts.designs.length === 0) throw new Error('Suite requires at least one design');

	const suiteName = opts.name ?? `Suite ${new Date().toLocaleString()}`;
	const suiteResult = db.prepare(`
		INSERT INTO decision_suites (decision_id, name, status, created_at)
		VALUES (?, ?, 'running', ?)
	`).run(opts.decision_id, suiteName, new Date().toISOString());
	const suiteId = suiteResult.lastInsertRowid as number;

	const emitter = new EventEmitter() as SuiteEmitter;
	emitter.setMaxListeners(50);
	activeSuites.set(suiteId, emitter);

	if (opts.ec2_server_id) {
		const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(opts.ec2_server_id) as Ec2Server | undefined;
		if (!ec2Server) throw new Error(`EC2 server ${opts.ec2_server_id} not found`);

		executeEc2SuiteAsync(suiteId, opts, ec2Server, emitter).catch(() => {});
	} else {
		executeLocalSuiteAsync(suiteId, opts, emitter).catch(() => {});
	}

	return suiteId;
}

async function executeLocalSuiteAsync(
	suiteId: number,
	opts: StartSuiteOptions,
	emitter: SuiteEmitter
): Promise<void> {
	const db = getDb();
	const total = opts.designs.length;

	for (let i = 0; i < opts.designs.length; i++) {
		const dc = opts.designs[i];
		const design = db.prepare('SELECT name, database FROM designs WHERE id = ?').get(dc.design_id) as
			{ name: string; database: string } | undefined;
		const designName = design?.name ?? `Design ${dc.design_id}`;

		emitter.emit('line', `\n[suite] Design ${i + 1}/${total}: "${designName}"`);

		let seriesId: number;
		try {
			seriesId = startSeries({
				design_id: dc.design_id,
				profile_ids: dc.profile_ids,
				delay_seconds: opts.delay_seconds,
				name: designName,
				server_id: opts.server_id,
				database: opts.database,
				snapshot_interval_seconds: opts.snapshot_interval_seconds,
				suite_id: suiteId,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emitter.emit('line', `[suite] Failed to start series for design ${dc.design_id}: ${msg}`);
			continue;
		}

		const seriesEmitter = getActiveSeries(seriesId);
		if (seriesEmitter) {
			const fwd = (line: string) => emitter.emit('line', line);
			seriesEmitter.on('line', fwd);
			await new Promise<void>((resolve) => {
				seriesEmitter.once('done', () => {
					seriesEmitter.off('line', fwd);
					resolve();
				});
			});
		}

		emitter.emit('series-done', { series_id: seriesId, design_id: dc.design_id, index: i });
	}

	db.prepare(`UPDATE decision_suites SET status='completed', finished_at=? WHERE id=?`)
		.run(new Date().toISOString(), suiteId);
	emitter.emit('line', '\n[suite] All designs completed.');
	emitter.emit('done');
	setTimeout(() => activeSuites.delete(suiteId), 60_000);
}

interface SuiteRunEntry {
	runId: number;
	token: string;
	profileName: string;
	seriesId: number;
	designId: number;
	designToken: string;
}

async function executeEc2SuiteAsync(
	suiteId: number,
	opts: StartSuiteOptions,
	ec2Server: Ec2Server,
	emitter: SuiteEmitter
): Promise<void> {
	const db = getDb();
	const suiteToken = randomUUID();
	db.prepare(`UPDATE decision_suites SET ec2_run_token=? WHERE id=?`).run(suiteToken, suiteId);

	const remoteDir = ec2Server.remote_dir;
	const logDir = ec2Server.log_dir || remoteDir;
	const binaryPath = `${remoteDir}/mybench-runner`;

	// Gather design info and create series + run rows upfront
	interface DesignEntry {
		designId: number;
		designName: string;
		designToken: string;
		seriesId: number;
		snapshot_interval_seconds: number;
		runs: SuiteRunEntry[];
	}
	const designEntries: DesignEntry[] = [];
	const now = new Date().toISOString();

	for (const dc of opts.designs) {
		const design = db.prepare(`
			SELECT name, database, pre_collect_secs, post_collect_secs, snapshot_interval_seconds
			FROM designs WHERE id = ?
		`).get(dc.design_id) as {
			name: string; database: string;
			pre_collect_secs: number; post_collect_secs: number; snapshot_interval_seconds: number;
		} | undefined;
		if (!design) continue;

		const designName = design.name;
		const designToken = randomUUID();
		const snapshot_interval_seconds = opts.snapshot_interval_seconds ?? design.snapshot_interval_seconds;

		// Create series row
		const seriesResult = db.prepare(`
			INSERT INTO benchmark_series (design_id, name, delay_seconds, status, created_at, suite_id, ec2_run_token)
			VALUES (?, ?, ?, 'running', ?, ?, ?)
		`).run(dc.design_id, designName, opts.delay_seconds, now, suiteId, designToken);
		const seriesId = seriesResult.lastInsertRowid as number;

		const runs: SuiteRunEntry[] = [];
		for (const profileId of dc.profile_ids) {
			const profile = db.prepare('SELECT name FROM design_param_profiles WHERE id = ?').get(profileId) as { name: string } | undefined;
			const profileName = profile?.name ?? '';
			const runToken = randomUUID();

			const resolvedDatabase = opts.database || design.database;
			const runResult = db.prepare(`
				INSERT INTO benchmark_runs (
					design_id, database, status, started_at,
					snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
					name, profile_name, ec2_server_id, ec2_run_token, series_id
				) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				dc.design_id, resolvedDatabase, now,
				snapshot_interval_seconds, design.pre_collect_secs, design.post_collect_secs,
				profileName, profileName, opts.ec2_server_id, runToken, seriesId
			);
			const runId = runResult.lastInsertRowid as number;

			db.prepare(`
				INSERT INTO run_step_results (run_id, step_id, position, name, type, status, started_at)
				VALUES (?, 0, 0, 'EC2 Remote Execution', 'sql', 'running', ?)
			`).run(runId, now);

			runs.push({ runId, token: runToken, profileName, seriesId, designId: dc.design_id, designToken });
		}

		designEntries.push({ designId: dc.design_id, designName, designToken, seriesId, snapshot_interval_seconds, runs });
	}

	let conn: import('ssh2').Client | null = null;

	try {
		conn = await connectSsh(ec2Server);
		const homeResult = await exec(conn, 'echo $HOME');
		const homeDir = homeResult.stdout.trim();
		const resolvedRemoteDir = remoteDir.replace(/^~/, homeDir);
		const resolvedLogDir = logDir.replace(/^~/, homeDir);
		const resolvedBinaryPath = binaryPath.replace(/^~/, homeDir);

		await exec(conn, `mkdir -p ${shellQuote(resolvedRemoteDir)}`);

		// Upload one plan file per design
		for (const de of designEntries) {
			const plan = generatePlan(de.designId, {
				server_id: opts.server_id,
				snapshot_interval_seconds: de.snapshot_interval_seconds,
				use_private_ip: !!opts.use_private_ip
			});
			const localPlanPath = `/tmp/mybench-suite-plan-${de.designToken}.json`;
			writeFileSync(localPlanPath, JSON.stringify(plan));
			const remotePlanPath = `${resolvedRemoteDir}/plan-${de.designToken}.json`;
			await uploadFile(conn, localPlanPath, remotePlanPath);
			try { unlinkSync(localPlanPath); } catch { /* ignore */ }
		}

		// Build single series command across all designs × profiles
		const cmdParts: string[] = [
			shellQuote(resolvedBinaryPath),
			'series',
			'--delay', String(opts.delay_seconds),
			'--log-dir', shellQuote(resolvedLogDir)
		];
		for (const de of designEntries) {
			const remotePlanPath = `${resolvedRemoteDir}/plan-${de.designToken}.json`;
			for (const run of de.runs) {
				const remoteResultPath = `${resolvedRemoteDir}/result-${run.token}.json`;
				cmdParts.push('--run', shellQuote(`${remotePlanPath},${run.profileName},${remoteResultPath}`));
			}
		}

		emitter.emit('line', `[suite] Starting EC2 suite: ${designEntries.length} design(s), ${designEntries.reduce((s, d) => s + d.runs.length, 0)} total runs`);
		const exitCode = await execStreaming(conn, cmdParts.join(' '), (line) => emitter.emit('line', line));
		if (exitCode !== 0) {
			emitter.emit('line', `[suite] EC2 suite process exited with code ${exitCode}`);
		}

		// Reconnect before downloading results — the long-lived execStreaming channel
		// can exhaust per-connection channel limits on the SSH server.
		conn.end();
		conn = await connectSsh(ec2Server);

		// Import results in order (design by design)
		let runIndex = 0;
		for (let di = 0; di < designEntries.length; di++) {
			const de = designEntries[di];
			emitter.emit('line', `\n[suite] Importing results for design ${di + 1}/${designEntries.length}: "${de.designName}"`);

			for (const run of de.runs) {
				runIndex++;
				const remoteResultPath = `${resolvedRemoteDir}/result-${run.token}.json`;
				const localResultPath = `/tmp/mybench-suite-result-${run.token}.json`;
				try {
					await downloadFile(conn, remoteResultPath, localResultPath);
					const resultJson = JSON.parse(readFileSync(localResultPath, 'utf8'));
					await importResultIntoRun(run.runId, resultJson);
					try { unlinkSync(localResultPath); } catch { /* ignore */ }
					emitter.emit('line', `[suite] Imported run ${runIndex} (profile: ${run.profileName})`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					emitter.emit('line', `[suite] Failed to import run ${runIndex}: ${msg}`);
					db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=?`)
						.run(new Date().toISOString(), run.runId);
				}
			}

			db.prepare(`UPDATE benchmark_series SET status='completed', finished_at=? WHERE id=?`)
				.run(new Date().toISOString(), de.seriesId);
			emitter.emit('series-done', { series_id: de.seriesId, design_id: de.designId, index: di });
		}

		// Cleanup remote files
		try {
			const planFiles = designEntries.map(de => `${resolvedRemoteDir}/plan-${de.designToken}.json`);
			const resultFiles = designEntries.flatMap(de => de.runs.map(r => `${resolvedRemoteDir}/result-${r.token}.json`));
			await exec(conn, `rm -f ${[...planFiles, ...resultFiles].map(shellQuote).join(' ')} && rm -rf ${shellQuote(resolvedLogDir)}`);
		} catch { /* ignore */ }

		db.prepare(`UPDATE decision_suites SET status='completed', finished_at=? WHERE id=?`)
			.run(new Date().toISOString(), suiteId);
		emitter.emit('line', '\n[suite] EC2 suite completed.');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emitter.emit('line', `\n[suite] Fatal error: ${msg}`);
		db.prepare(`UPDATE decision_suites SET status='failed', finished_at=? WHERE id=?`)
			.run(new Date().toISOString(), suiteId);
		for (const de of designEntries) {
			db.prepare(`UPDATE benchmark_series SET status='failed', finished_at=? WHERE id=?`)
				.run(new Date().toISOString(), de.seriesId);
			for (const run of de.runs) {
				db.prepare(`UPDATE benchmark_runs SET status='failed', finished_at=? WHERE id=? AND status='running'`)
					.run(new Date().toISOString(), run.runId);
			}
		}
	} finally {
		conn?.end();
		emitter.emit('done');
		setTimeout(() => activeSuites.delete(suiteId), 60_000);
	}
}

export function recoverStaleLocalSuites(): void {
	const db = getDb();
	const result = db.prepare(`
		UPDATE decision_suites SET status='failed', finished_at=?
		WHERE status='running' AND ec2_run_token IS NULL
	`).run(new Date().toISOString());
	if (result.changes > 0) {
		console.log(`[suite-executor] Marked ${result.changes} stale local suite(s) as failed`);
	}
}
