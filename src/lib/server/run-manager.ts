import { EventEmitter } from 'events';
import getDb from './db';

export interface ActivePhase {
	name: 'pre' | 'post';
	status: 'running' | 'completed';
	duration_secs: number;
	started_ms: number;
}

export interface ActiveRun {
	emitter: EventEmitter;
	currentPhase: ActivePhase | null;
}

const activeRuns = new Map<number, ActiveRun>();

export function createRun(runId: number): ActiveRun {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(50);
	const run: ActiveRun = { emitter, currentPhase: null };
	activeRuns.set(runId, run);
	return run;
}

export function getActiveRun(runId: number): ActiveRun | undefined {
	return activeRuns.get(runId);
}

export function setActivePhase(runId: number, phase: ActivePhase | null) {
	const run = activeRuns.get(runId);
	if (run) run.currentPhase = phase;
}

export function completeRun(runId: number) {
	const run = activeRuns.get(runId);
	if (!run) return;
	run.emitter.emit('done');
	// Keep in map for SSE replay; clean up after a delay
	setTimeout(() => activeRuns.delete(runId), 60_000);
}

// On startup, reset stale local runs to failed. EC2 runs are handled separately by recoverEc2Runs().
export function recoverStaleRuns() {
	const db = getDb();
	const now = new Date().toISOString();
	const stale = db.prepare(`
		UPDATE benchmark_runs SET status = 'failed', finished_at = ?
		WHERE status = 'running' AND (ec2_server_id IS NULL OR ec2_run_token IS NULL)
	`).run(now);
	if (stale.changes > 0) {
		console.log(`[run-manager] Reset ${stale.changes} stale local runs to failed`);
	}
	// Reset pending series runs (can't resume — series restart required)
	const pending = db.prepare(`
		UPDATE benchmark_runs SET status = 'failed', finished_at = ?
		WHERE status = 'pending' AND series_id IS NOT NULL
	`).run(now);
	if (pending.changes > 0) {
		console.log(`[run-manager] Reset ${pending.changes} pending series runs to failed`);
	}
	// Mark orphaned local series as failed
	const seriesFailed = db.prepare(`
		UPDATE benchmark_series SET status = 'failed', finished_at = ?
		WHERE status = 'running' AND ec2_run_token IS NULL
	`).run(now);
	if (seriesFailed.changes > 0) {
		console.log(`[run-manager] Reset ${seriesFailed.changes} stale local series to failed`);
	}
}
