import getDb from '$lib/server/db';
import { collectForDuration } from '$lib/server/pg-stats';
import { setActivePhase } from '$lib/server/run-manager';
import type { StepContext, StepResult } from './types';

export async function executeCollectStep(ctx: StepContext): Promise<StepResult> {
	const { step, runId, pool, enabledTables, snapshotIntervalSecs, activeRun, seenBench } = ctx;
	const db = getDb();

	const phase = seenBench ? 'post' : 'pre';
	const durationSecs = step.duration_secs ?? 0;

	if (durationSecs > 0 && enabledTables.length > 0) {
		const phaseObj = { name: phase as 'pre' | 'post', status: 'running' as const, duration_secs: durationSecs, started_ms: Date.now() };
		setActivePhase(runId, phaseObj);
		activeRun.emitter.emit('phase', phaseObj);
		activeRun.emitter.emit('line', `[snapshot] Collecting pg_stat_* for ${durationSecs}s...`);
		if (phase === 'post') {
			db.prepare(`UPDATE benchmark_runs SET post_started_at=? WHERE id=?`).run(new Date().toISOString(), runId);
		}
		await collectForDuration(pool, runId, enabledTables, phase, durationSecs, snapshotIntervalSecs);
		const phaseDone = { ...phaseObj, status: 'completed' as const };
		setActivePhase(runId, phase === 'post' ? null : phaseDone);
		activeRun.emitter.emit('phase', phaseDone);
	} else {
		activeRun.emitter.emit('line', durationSecs <= 0 ? '[snapshot] Duration is 0, skipping.' : '[snapshot] No tables enabled, skipping.');
	}

	return { exitCode: 0 };
}
