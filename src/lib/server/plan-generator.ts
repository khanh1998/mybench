import getDb from '$lib/server/db';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import type { PgbenchScript, DesignParam, DesignStep, PgServer } from '$lib/types';

const EXCLUDED_SNAP_COLS = new Set(['_id', '_run_id', '_collected_at', '_phase', '_is_baseline']);

export interface PlanRunSettingsOverride {
	snapshot_interval_seconds?: number;
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

	const stepsWithScripts = steps.map(s => ({
		id: s.id,
		position: s.position,
		name: s.name,
		type: s.type,
		enabled: !!s.enabled,
		script: s.script,
		no_transaction: !!s.no_transaction,
		duration_secs: s.duration_secs,
		pgbench_options: s.pgbench_options,
		pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []).map(ps => ({
			id: ps.id,
			name: ps.name,
			weight: ps.weight,
			script: ps.script
		})) : []
	}));

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(designId) as DesignParam[];

	// Load profiles with their values
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
	const profiles = profileRows.map(p => ({
		name: p.name,
		values: profileValuesById.get(p.id) ?? []
	}));

	// Load server info
	let serverInfo = {
		host: '',
		port: 5432,
		username: '',
		password: '',
		database: design.database,
		ssl: false
	};
	if (design.server_id) {
		const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(design.server_id) as PgServer | undefined;
		if (server) {
			serverInfo = {
				host: server.host,
				port: server.port,
				username: server.username,
				password: server.password,
				database: design.database,
				ssl: !!server.ssl
			};
		}
	}

	// Load enabled snap tables for this server
	const enabledSnapTables: Array<{ pg_view_name: string; snap_table_name: string; columns: string[] }> = [];
	if (design.server_id) {
		const enabledRows = db.prepare(
			`SELECT table_name FROM pg_stat_table_selections WHERE server_id = ? AND enabled = 1`
		).all(design.server_id) as { table_name: string }[];

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
		params: designParams.map(p => ({ name: p.name, value: p.value })),
		profiles,
		steps: stepsWithScripts,
		enabled_snap_tables: enabledSnapTables
	};
}
