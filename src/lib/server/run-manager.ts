import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type pg from 'pg';
import getDb from './db';

export interface ActivePhase {
	name: 'pre' | 'post';
	status: 'running' | 'completed';
	duration_secs: number;
	started_ms: number;
}

export interface ActiveRun {
	emitter: EventEmitter;
	process: ChildProcess | null;
	pool: pg.Pool | null;
	snapshotTimer: NodeJS.Timeout | null;
	currentPhase: ActivePhase | null;
}

const activeRuns = new Map<number, ActiveRun>();

export function createRun(runId: number): ActiveRun {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(50);
	const run: ActiveRun = { emitter, process: null, pool: null, snapshotTimer: null, currentPhase: null };
	activeRuns.set(runId, run);
	return run;
}

export function getActiveRun(runId: number): ActiveRun | undefined {
	return activeRuns.get(runId);
}

export function setProcess(runId: number, proc: ChildProcess) {
	const run = activeRuns.get(runId);
	if (run) run.process = proc;
}

export function setPool(runId: number, pool: pg.Pool) {
	const run = activeRuns.get(runId);
	if (run) run.pool = pool;
}

export function setSnapshotTimer(runId: number, timer: NodeJS.Timeout) {
	const run = activeRuns.get(runId);
	if (run) run.snapshotTimer = timer;
}

export function setActivePhase(runId: number, phase: ActivePhase | null) {
	const run = activeRuns.get(runId);
	if (run) run.currentPhase = phase;
}

export function completeRun(runId: number) {
	const run = activeRuns.get(runId);
	if (!run) return;
	if (run.snapshotTimer) clearInterval(run.snapshotTimer);
	run.emitter.emit('done');
	// Keep in map for SSE replay; clean up after a delay
	setTimeout(() => activeRuns.delete(runId), 60_000);
}

export async function stopRun(runId: number) {
	const run = activeRuns.get(runId);
	if (!run) return;
	if (run.snapshotTimer) clearInterval(run.snapshotTimer);
	if (run.process) run.process.kill('SIGTERM');
	if (run.pool) await run.pool.end().catch(() => {});
	run.emitter.emit('done');
	activeRuns.delete(runId);
}

// On startup, reset any stale running runs
export function recoverStaleRuns() {
	const db = getDb();
	const stale = db.prepare(`UPDATE benchmark_runs SET status = 'failed', finished_at = ? WHERE status = 'running'`).run(new Date().toISOString());
	if (stale.changes > 0) {
		console.log(`[run-manager] Reset ${stale.changes} stale running runs to failed`);
	}
}
