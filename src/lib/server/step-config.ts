import getDb from '$lib/server/db';

/**
 * Per-step configuration snapshot stored in run_step_results.config_json.
 *
 * Captures what each step was configured to do at launch time — with {{PARAM}}
 * placeholders resolved against the plan params + the run's profile — so the
 * run detail page can show exactly what ran even after the design is edited.
 */

interface PlanParam { name: string; value: string }
interface PlanProfile { name: string; values: { param_name: string; value: string }[] }
interface PlanStep {
	id: number;
	type: string;
	script?: string;
	no_transaction?: boolean;
	duration_secs?: number;
	pgbench_options?: string;
	pgbench_scripts?: { name: string; weight: number; weight_expr?: string | null }[];
	[key: string]: unknown;
}
interface PlanShape {
	params?: PlanParam[];
	profiles?: PlanProfile[];
	steps?: PlanStep[];
	pg_stat_step?: {
		interval_seconds: number;
		snap_tables: { pg_view_name: string }[];
		pg_locks_enabled: boolean;
		pg_locks_interval_seconds: number;
		reset_stats: boolean;
		reset_statements: boolean;
		pss_track_planning: boolean;
		collect_statements: boolean;
	} | null;
	proc_step?: { groups: string[]; interval_seconds: number; collect_runner: boolean } | null;
	run_settings?: { snapshot_interval_seconds?: number };
}

const PERF_FIELDS = [
	'perf_stat_enabled', 'perf_record_enabled', 'perf_trace_enabled', 'perf_c2c_enabled',
	'perf_events', 'perf_duration',
	'perf_stat_duration', 'perf_stat_delay',
	'perf_record_duration', 'perf_record_delay',
	'perf_trace_duration', 'perf_trace_delay',
	'perf_c2c_duration', 'perf_c2c_delay', 'perf_ldlat',
	'perf_delay', 'perf_cgroup', 'perf_repeat', 'perf_freq', 'perf_call_graph', 'perf_mmap_pages'
];

/** Mirrors the CLI: profile values override plan params (plan.ApplyProfile). */
export function resolvePlanParams(plan: PlanShape, profileName: string): PlanParam[] {
	const map = new Map((plan.params ?? []).map(p => [p.name, p.value]));
	const profile = profileName ? plan.profiles?.find(p => p.name === profileName) : undefined;
	for (const v of profile?.values ?? []) map.set(v.param_name, v.value);
	return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

function substitute(text: string, params: PlanParam[]): string {
	let out = text;
	for (const p of params) out = out.split(`{{${p.name}}}`).join(p.value);
	return out;
}

export function buildStepConfigs(planObj: object, profileName: string): Map<number, Record<string, unknown>> {
	const plan = planObj as PlanShape;
	const params = resolvePlanParams(plan, profileName);
	const configs = new Map<number, Record<string, unknown>>();

	for (const step of plan.steps ?? []) {
		let cfg: Record<string, unknown> | null = null;
		switch (step.type) {
			case 'sql':
				cfg = { script: substitute(step.script ?? '', params), no_transaction: !!step.no_transaction };
				break;
			case 'pgbench':
				cfg = {
					options: substitute(step.pgbench_options ?? '', params),
					scripts: (step.pgbench_scripts ?? []).map(s => ({
						name: s.name,
						weight: s.weight_expr ? substitute(s.weight_expr, params) : s.weight
					}))
				};
				break;
			case 'sysbench':
				cfg = {
					options: substitute(step.pgbench_options ?? '', params),
					script: substitute(step.script ?? '', params),
					duration_secs: step.duration_secs ?? 0
				};
				break;
			case 'perf': {
				cfg = {};
				for (const f of PERF_FIELDS) {
					const v = step[f];
					if (v === undefined || v === '' || v === false) continue;
					cfg[f.replace(/^perf_/, '')] = typeof v === 'string' ? substitute(v, params) : v;
				}
				break;
			}
			case 'pg_stat': {
				const p = plan.pg_stat_step;
				cfg = p
					? {
						interval_seconds: p.interval_seconds || plan.run_settings?.snapshot_interval_seconds || 0,
						tables: p.snap_tables.map(t => t.pg_view_name),
						collect_statements: p.collect_statements,
						pg_locks_enabled: p.pg_locks_enabled,
						pg_locks_interval_seconds: p.pg_locks_interval_seconds,
						reset_stats: p.reset_stats,
						reset_statements: p.reset_statements,
						pss_track_planning: p.pss_track_planning
					}
					: {};
				break;
			}
			case 'proc': {
				const p = plan.proc_step;
				cfg = p
					? {
						groups: p.groups.length > 0 ? p.groups : ['(all)'],
						interval_seconds: p.interval_seconds || plan.run_settings?.snapshot_interval_seconds || 0,
						collect_runner: p.collect_runner
					}
					: {};
				break;
			}
		}
		if (cfg) configs.set(step.id, cfg);
	}
	return configs;
}

/** Writes config_json onto the pre-created run_step_results rows for a run. */
export function storeStepConfigs(runId: number, plan: object, profileName: string): void {
	const db = getDb();
	const upd = db.prepare('UPDATE run_step_results SET config_json = ? WHERE run_id = ? AND step_id = ?');
	const configs = buildStepConfigs(plan, profileName);
	db.transaction(() => {
		for (const [stepId, cfg] of configs) upd.run(JSON.stringify(cfg), runId, stepId);
	})();
}
