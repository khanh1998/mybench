import getDb from '$lib/server/db';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import type { PgbenchScript, DesignParam, DesignStep, PgServer, DecisionParam } from '$lib/types';

const EXCLUDED_SNAP_COLS = new Set(['_id', '_run_id', '_collected_at', '_phase', '_is_baseline', '_step_id']);

export interface PlanRunSettingsOverride {
	server_id?: number;
	database?: string;
	snapshot_interval_seconds?: number;
	use_private_ip?: boolean;
	suiteMode?: boolean;
}

function mergeParams(
	base: { name: string; value: string }[],
	override: { name: string; value: string }[]
): { name: string; value: string }[] {
	const map = new Map(base.map(p => [p.name, p.value]));
	for (const p of override) map.set(p.name, p.value);
	return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

/**
 * Generates the plan JSON for a design, suitable for passing to mybench-runner.
 * Optionally override run_settings fields (e.g. snapshot_interval_seconds).
 */
export function generatePlan(designId: number, overrides: PlanRunSettingsOverride = {}): object {
	const db = getDb();

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId) as {
		id: number; decision_id: number; name: string; description: string;
		server_id: number | null; database: string;
		pre_collect_secs: number; post_collect_secs: number;
		snapshot_interval_seconds: number;
	} | undefined;
	if (!design) throw new Error(`Design ${designId} not found`);

	const resolvedServerId = overrides.server_id ?? design.server_id;
	const resolvedDatabase = overrides.database ?? design.database;

	// Load enabled steps only
	const steps = db.prepare(
		'SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position'
	).all(designId) as DesignStep[];

	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ? AND enabled = 1) ORDER BY step_id, position'
	).all(designId) as PgbenchScript[];

	const scriptsByStep = new Map<number, PgbenchScript[]>();
	for (const ps of pgbenchScripts) {
		const arr = scriptsByStep.get(ps.step_id) ?? [];
		arr.push(ps);
		scriptsByStep.set(ps.step_id, arr);
	}

	const stepsWithScripts = steps.map(s => {
		const base = {
			id: s.id,
			position: s.position,
			name: s.name,
			type: s.type,
			enabled: !!s.enabled
		};
		if (s.type === 'perf') {
			return {
				...base,
				perf_stat_enabled: !!s.perf_stat_enabled,
				perf_record_enabled: !!s.perf_record_enabled,
				perf_trace_enabled: !!s.perf_trace_enabled,
				perf_events: s.perf_events ?? '',
				perf_duration: s.perf_duration ?? '',
				perf_stat_duration: s.perf_stat_duration ?? '',
				perf_record_duration: s.perf_record_duration ?? '',
				perf_trace_duration: s.perf_trace_duration ?? '',
				perf_delay: s.perf_delay ?? '',
				perf_stat_delay: s.perf_stat_delay ?? '',
				perf_record_delay: s.perf_record_delay ?? '',
				perf_trace_delay: s.perf_trace_delay ?? '',
				perf_cgroup: s.perf_cgroup ?? '',
				perf_repeat: s.perf_repeat ?? '',
				perf_freq: s.perf_freq ?? '',
				perf_call_graph: s.perf_call_graph ?? 'dwarf'
			};
		}
		return {
			...base,
			script: s.script,
			no_transaction: !!s.no_transaction,
			duration_secs: s.duration_secs,
			pgbench_options: s.pgbench_options,
			pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []).map(ps => ({
				id: ps.id,
				name: ps.name,
				weight: ps.weight,
				weight_expr: ps.weight_expr ?? null,
				script: ps.script
			})) : []
		};
	});

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(designId) as DesignParam[];

	// Load decision-level params and profiles
	const decisionParams = db.prepare(
		'SELECT * FROM decision_params WHERE decision_id = ? ORDER BY position'
	).all(design.decision_id) as DecisionParam[];

	const decisionProfileRows = db.prepare(
		'SELECT * FROM decision_param_profiles WHERE decision_id = ? ORDER BY id'
	).all(design.decision_id) as { id: number; name: string }[];
	const decisionProfileValueRows = db.prepare(
		'SELECT * FROM decision_param_profile_values WHERE profile_id IN (SELECT id FROM decision_param_profiles WHERE decision_id = ?) ORDER BY profile_id, id'
	).all(design.decision_id) as { profile_id: number; param_name: string; value: string }[];
	const decisionProfileValuesById = new Map<number, { param_name: string; value: string }[]>();
	for (const v of decisionProfileValueRows) {
		const arr = decisionProfileValuesById.get(v.profile_id) ?? [];
		arr.push({ param_name: v.param_name, value: v.value });
		decisionProfileValuesById.set(v.profile_id, arr);
	}
	const decisionProfiles = decisionProfileRows.map(p => ({
		name: p.name,
		values: decisionProfileValuesById.get(p.id) ?? []
	}));

	// Load design-level profiles with their values
	const profileRows = db.prepare(
		'SELECT * FROM design_param_profiles WHERE design_id = ? ORDER BY id'
	).all(designId) as { id: number; name: string }[];
	const profileValueRows = db.prepare(
		'SELECT * FROM design_param_profile_values WHERE profile_id IN (SELECT id FROM design_param_profiles WHERE design_id = ?) ORDER BY profile_id, id'
	).all(designId) as { profile_id: number; param_name: string; value: string }[];
	const profileValuesById = new Map<number, { param_name: string; value: string }[]>();
	for (const v of profileValueRows) {
		const arr = profileValuesById.get(v.profile_id) ?? [];
		arr.push({ param_name: v.param_name, value: v.value });
		profileValuesById.set(v.profile_id, arr);
	}
	const designProfiles = profileRows.map(p => ({
		name: p.name,
		values: profileValuesById.get(p.id) ?? []
	}));

	const suiteMode = overrides.suiteMode ?? false;
	const effectiveParams = suiteMode
		? decisionParams.map(p => ({ name: p.name, value: p.value }))
		: mergeParams(decisionParams.map(p => ({ name: p.name, value: p.value })), designParams.map(p => ({ name: p.name, value: p.value })));
	const profiles = suiteMode
		? decisionProfiles
		: [...decisionProfiles, ...designProfiles];

	// Load server info
	let serverInfo = {
		host: '',
		port: 5432,
		username: '',
		password: '',
		database: resolvedDatabase,
		ssl: false,
		ssh_enabled: false,
		ssh_host: '',
		ssh_port: 22,
		ssh_user: '',
		ssh_private_key: '',
		perf_enabled: false,
		perf_scope: 'disabled',
		perf_cgroup: '',
		perf_events: ''
	};
	if (resolvedServerId) {
		const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(resolvedServerId) as PgServer | undefined;
		if (server) {
			const resolvedHost = (overrides.use_private_ip && server.private_host) ? server.private_host : server.host;
			serverInfo = {
				host: resolvedHost,
				port: server.port,
				username: server.username,
				password: server.password,
				database: resolvedDatabase,
				ssl: !!server.ssl,
				ssh_enabled: !!server.ssh_enabled,
				ssh_host: server.ssh_host ?? '',
				ssh_port: server.ssh_port ?? 22,
				ssh_user: server.ssh_user ?? '',
				ssh_private_key: server.ssh_private_key ?? '',
				perf_enabled: !!server.perf_enabled,
				perf_scope: server.perf_scope ?? 'disabled',
				perf_cgroup: server.perf_cgroup ?? '',
				perf_events: server.perf_events ?? ''
			};
		}
	}

	// Load enabled snap tables for this server
	const enabledSnapTables: Array<{ pg_view_name: string; snap_table_name: string; columns: string[] }> = [];
	if (resolvedServerId) {
		const enabledRows = db.prepare(
			`SELECT table_name FROM pg_stat_table_selections WHERE server_id = ? AND enabled = 1`
		).all(resolvedServerId) as { table_name: string }[];

		for (const row of enabledRows) {
			const pgViewName = row.table_name;
			const snapTableName = SNAP_TABLE_MAP[pgViewName];
			if (!snapTableName) continue;

			let columns: string[] = [];
			try {
				const pragmaRows = db.prepare(`PRAGMA table_info(${snapTableName})`).all() as { name: string }[];
				if (pragmaRows.length > 0) {
					columns = pragmaRows
						.map(r => r.name)
						.filter(name => !EXCLUDED_SNAP_COLS.has(name));
				}
			} catch {
				// Table doesn't exist yet — fall back to empty columns
			}

			enabledSnapTables.push({
				pg_view_name: pgViewName,
				snap_table_name: snapTableName,
				columns
			});
		}
	}

	if (steps.some((step) => step.type === 'pg_stat_statements_collect')) {
		let columns: string[] = [];
		try {
			const pragmaRows = db.prepare(`PRAGMA table_info(snap_pg_stat_statements)`).all() as { name: string }[];
			if (pragmaRows.length > 0) {
				columns = pragmaRows.map((r) => r.name).filter((name) => !EXCLUDED_SNAP_COLS.has(name));
			}
		} catch {
			// table doesn't exist yet
		}

		enabledSnapTables.push({
			pg_view_name: 'pg_stat_statements',
			snap_table_name: 'snap_pg_stat_statements',
			columns
		});
	}

	return {
		version: 1,
		exported_at: new Date().toISOString(),
		design_id: design.id,
		design_name: design.name,
		server: serverInfo,
		run_settings: {
			snapshot_interval_seconds: overrides.snapshot_interval_seconds ?? design.snapshot_interval_seconds,
			pre_collect_secs: design.pre_collect_secs,
			post_collect_secs: design.post_collect_secs
		},
		params: effectiveParams,
		profiles,
		steps: stepsWithScripts,
		enabled_snap_tables: enabledSnapTables
	};
}
