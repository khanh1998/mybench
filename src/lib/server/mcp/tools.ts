import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import getDb from '$lib/server/db';
import { createPool } from '$lib/server/pg-client';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import { startRun } from '$lib/server/run-executor';
import type { PgServer, DesignStep, PgbenchScript, DesignParam } from '$lib/types';

const EXCLUDED_SNAP_COLS = new Set(['_id', '_run_id', '_collected_at', '_phase', '_is_baseline']);

function text(obj: unknown): { content: [{ type: 'text'; text: string }] } {
	return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

export function registerTools(server: McpServer): void {
	// ─────────────────────────────────────────────────────────────────────────
	// get_context
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'get_context',
		`Returns a complete guide to mybench. Call this first before using any other tool.
Covers: data model, step types, {{PARAM}} syntax, pgbench script format, and the recommended
workflow for creating and running a benchmark plan.`,
		{},
		async () => {
			const guide = {
				overview: 'mybench helps you design and run PostgreSQL benchmarks. Use these tools to create plans, run tests, and export results.',
				data_model: {
					decisions: 'Top-level question you are answering (e.g. "Which table design is faster?"). Contains one or more designs.',
					designs: 'One candidate design to benchmark (e.g. "plain table" vs "partitioned table"). Each design has steps and params.',
					steps: 'Ordered list of actions to run: sql setup → collect pre-stats → pgbench load test → collect post-stats → sql teardown.',
					params: 'Named values (e.g. NUM_USERS=1000) substituted as {{NAME}} in all step scripts.'
				},
				step_types: {
					sql: {
						description: 'Runs a SQL script via psql. Use for CREATE TABLE, INSERT seed data, DROP TABLE, etc.',
						fields: { name: 'string', type: '"sql"', position: 'integer (order)', script: 'SQL text (supports {{PARAM}})', no_transaction: 'boolean — if true, omit --single-transaction wrapper', enabled: 'boolean' }
					},
					pgbench: {
						description: 'Runs a pgbench load test. Measures TPS and latency.',
						fields: {
							name: 'string',
							type: '"pgbench"',
							position: 'integer',
							pgbench_options: 'string — e.g. "-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum --protocol=prepared"',
							pgbench_scripts: 'array of {name, weight, script} — pgbench custom script language',
							enabled: 'boolean'
						},
						pgbench_script_language: 'Each script uses pgbench syntax: \\set varname expr, BEGIN, SQL statements, END. Supports {{PARAM}} substitution.'
					},
					collect: {
						description: 'Takes periodic pg_stat_* snapshots for duration_secs seconds. Place before pgbench (phase=pre) and after (phase=post).',
						fields: { name: 'string', type: '"collect"', position: 'integer', duration_secs: 'integer — how long to collect', enabled: 'boolean' }
					}
				},
				param_syntax: 'Write {{PARAM_NAME}} in any step script or pgbench_options. Values are set with set_params. Example: "INSERT INTO users SELECT generate_series(1, {{NUM_USERS}})"',
				recommended_workflow: [
					'1. get_context (this tool) — understand conventions',
					'2. list_decisions — find or create a decision',
					'3. get_db_schema(design_id) — learn real table/column names before writing SQL',
					'4. create_design(decision_id, name) — create a new design',
					'5. set_params(design_id, [{name, value}]) — define {{PARAM}} values',
					'6. upsert_step (repeat) — add sql/pgbench/collect steps in order',
					'7. run_design(design_id) — start test run, get run_id',
					'8. get_run(run_id) — poll until status is "completed" or "failed"',
					'9. export_plan(design_id) — get plan.json for production EC2 run'
				],
				example_steps: {
					sql_setup: {
						type: 'sql',
						name: 'Setup',
						position: 0,
						script: 'DROP TABLE IF EXISTS payments;\nCREATE TABLE payments (id BIGSERIAL PRIMARY KEY, user_id INT, amount INT);\nINSERT INTO payments (user_id, amount) SELECT (random()*{{NUM_USERS}})::int, (random()*1000)::int FROM generate_series(1, {{NUM_ROWS}});',
						enabled: true
					},
					collect_pre: { type: 'collect', name: 'pre collect', position: 1, duration_secs: 15, enabled: true },
					pgbench: {
						type: 'pgbench',
						name: 'Benchmark',
						position: 2,
						pgbench_options: '-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum',
						pgbench_scripts: [{ name: 'main', weight: 1, script: '\\set uid random(1, {{NUM_USERS}})\nBEGIN;\nUPDATE payments SET amount = amount - 10 WHERE user_id = :uid;\nEND;' }],
						enabled: true
					},
					collect_post: { type: 'collect', name: 'post collect', position: 3, duration_secs: 15, enabled: true },
					sql_teardown: { type: 'sql', name: 'Teardown', position: 4, script: 'DROP TABLE IF EXISTS payments;', enabled: true }
				}
			};
			return text(guide);
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// list_decisions
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'list_decisions',
		'Lists all decisions and their designs. A decision is a benchmarking question (e.g. "plain table vs partitioned"). Each decision has one or more designs to compare.',
		{},
		async () => {
			const db = getDb();
			const decisions = db.prepare('SELECT * FROM decisions ORDER BY id').all() as { id: number; name: string; description: string }[];
			const designs = db.prepare('SELECT id, decision_id, name, description FROM designs ORDER BY id').all() as { id: number; decision_id: number; name: string; description: string }[];
			const byDecision = new Map<number, typeof designs>();
			for (const d of designs) {
				const arr = byDecision.get(d.decision_id) ?? [];
				arr.push(d);
				byDecision.set(d.decision_id, arr);
			}
			return text(decisions.map(dec => ({ ...dec, designs: byDecision.get(dec.id) ?? [] })));
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_design
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'get_design',
		'Returns a design with all its steps, pgbench scripts, and params. Use this to inspect an existing design before modifying it.',
		{ design_id: z.number().int().describe('Design ID from list_decisions') },
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id);
			if (!design) return text({ error: `Design ${design_id} not found` });

			const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(design_id) as DesignStep[];
			const scripts = db.prepare('SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position').all(design_id) as PgbenchScript[];
			const params = db.prepare('SELECT * FROM design_params WHERE design_id = ? ORDER BY position').all(design_id) as DesignParam[];

			const scriptsByStep = new Map<number, PgbenchScript[]>();
			for (const ps of scripts) {
				const arr = scriptsByStep.get(ps.step_id) ?? [];
				arr.push(ps);
				scriptsByStep.set(ps.step_id, arr);
			}

			return text({
				...design,
				steps: steps.map(s => ({ ...s, pgbench_scripts: scriptsByStep.get(s.id) ?? [] })),
				params
			});
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// create_design
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'create_design',
		'Creates a new design under a decision. After creating, use upsert_step to add steps and set_params to define parameters.',
		{
			decision_id: z.number().int().describe('Decision ID from list_decisions'),
			name: z.string().describe('Short name for this design, e.g. "plain table" or "partitioned"'),
			description: z.string().optional().describe('Optional description')
		},
		async ({ decision_id, name, description }) => {
			const db = getDb();
			const result = db.prepare(
				'INSERT INTO designs (decision_id, name, description) VALUES (?, ?, ?)'
			).run(decision_id, name, description ?? '');
			return text({ design_id: result.lastInsertRowid });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// upsert_step
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'upsert_step',
		`Adds a new step or updates an existing step. If step_id is provided, updates that step; otherwise inserts a new one.
Step types:
  - "sql": provide script (SQL text, supports {{PARAM}})
  - "pgbench": provide pgbench_options and pgbench_scripts [{name, weight, script}]
  - "collect": provide duration_secs (seconds to collect pg_stat_* snapshots)
Position determines execution order (lower = earlier). Use {{PARAM_NAME}} in scripts.`,
		{
			design_id: z.number().int(),
			step_id: z.number().int().optional().describe('Omit to create a new step'),
			type: z.enum(['sql', 'pgbench', 'collect']),
			name: z.string(),
			position: z.number().int().describe('Execution order, 0-based'),
			enabled: z.boolean().default(true),
			script: z.string().optional().describe('SQL script (for type=sql)'),
			no_transaction: z.boolean().optional().describe('If true, SQL runs without --single-transaction wrapper'),
			pgbench_options: z.string().optional().describe('pgbench CLI options, e.g. "-c 10 -j 2 -T 60 --no-vacuum"'),
			pgbench_scripts: z.array(z.object({
				name: z.string(),
				weight: z.number().int().default(1),
				script: z.string().describe('pgbench custom script with \\set, BEGIN/END, SQL, and {{PARAM}} placeholders')
			})).optional().describe('Required for type=pgbench'),
			duration_secs: z.number().int().optional().describe('Collection duration (for type=collect)')
		},
		async ({ design_id, step_id, type, name, position, enabled, script, no_transaction, pgbench_options, pgbench_scripts, duration_secs }) => {
			const db = getDb();
			let resolvedStepId: number;

			if (step_id) {
				db.prepare(`UPDATE design_steps SET type=?, name=?, position=?, enabled=?, script=?, no_transaction=?, pgbench_options=?, duration_secs=? WHERE id=?`)
					.run(type, name, position, enabled ? 1 : 0, script ?? '', no_transaction ? 1 : 0, pgbench_options ?? '', duration_secs ?? 0, step_id);
				resolvedStepId = step_id;
			} else {
				const result = db.prepare(
					'INSERT INTO design_steps (design_id, type, name, position, enabled, script, no_transaction, pgbench_options, duration_secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(design_id, type, name, position, enabled ? 1 : 0, script ?? '', no_transaction ? 1 : 0, pgbench_options ?? '', duration_secs ?? 0);
				resolvedStepId = result.lastInsertRowid as number;
			}

			if (type === 'pgbench' && pgbench_scripts) {
				db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?').run(resolvedStepId);
				const insertScript = db.prepare('INSERT INTO pgbench_scripts (step_id, position, name, weight, script) VALUES (?, ?, ?, ?, ?)');
				pgbench_scripts.forEach((ps, i) => insertScript.run(resolvedStepId, i, ps.name, ps.weight, ps.script));
			}

			return text({ step_id: resolvedStepId, action: step_id ? 'updated' : 'created' });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// delete_step
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'delete_step',
		'Deletes a step and its pgbench scripts. Use get_design first to find the step_id.',
		{ step_id: z.number().int() },
		async ({ step_id }) => {
			const db = getDb();
			db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?').run(step_id);
			db.prepare('DELETE FROM design_steps WHERE id = ?').run(step_id);
			return text({ deleted: true, step_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// set_params
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'set_params',
		`Replaces all parameters for a design. Parameters are substituted as {{NAME}} in step scripts and pgbench_options.
Pass the complete list — this replaces, not merges.`,
		{
			design_id: z.number().int(),
			params: z.array(z.object({
				name: z.string().describe('Parameter name, used as {{NAME}} in scripts'),
				value: z.string().describe('Default value — can be overridden with --param on the CLI runner')
			}))
		},
		async ({ design_id, params }) => {
			const db = getDb();
			db.transaction(() => {
				db.prepare('DELETE FROM design_params WHERE design_id = ?').run(design_id);
				const insert = db.prepare('INSERT INTO design_params (design_id, position, name, value) VALUES (?, ?, ?, ?)');
				params.forEach((p, i) => insert.run(design_id, i, p.name, p.value));
			})();
			return text({ set: params.length, design_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// run_design
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'run_design',
		`Starts a benchmark run for a design. Returns run_id immediately — poll get_run(run_id) until status is "completed" or "failed".
The run executes all enabled steps in order: sql setup, pre-collect, pgbench, post-collect, sql teardown.
This is a test/validation run — for production benchmarks use export_plan and the mybench-runner CLI.`,
		{ design_id: z.number().int() },
		async ({ design_id }) => {
			const runId = startRun(design_id);
			return text({ run_id: runId, message: 'Run started. Poll get_run(run_id) for status.' });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_run
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'get_run',
		`Returns the status and results of a benchmark run. Poll this after run_design.
status: "running" | "completed" | "failed" | "stopped"
When completed: tps, latency_avg_ms, latency_stddev_ms, transactions are populated.`,
		{ run_id: z.number().int() },
		async ({ run_id }) => {
			const db = getDb();
			const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(run_id);
			if (!run) return text({ error: `Run ${run_id} not found` });
			return text(run);
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// export_plan
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'export_plan',
		`Returns the plan.json for a design — the file to pass to mybench-runner for production EC2 benchmarking.
Contains: server config, all enabled steps with scripts, params, and enabled pg_stat table specs.
Use this after validating the plan with run_design.`,
		{ design_id: z.number().int() },
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id) as {
				id: number; name: string; server_id: number | null; database: string;
				pre_collect_secs: number; post_collect_secs: number; snapshot_interval_seconds: number;
			} | undefined;
			if (!design) return text({ error: `Design ${design_id} not found` });

			const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? AND enabled = 1 ORDER BY position').all(design_id) as DesignStep[];
			const pgbenchScripts = db.prepare('SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ? AND enabled = 1) ORDER BY step_id, position').all(design_id) as PgbenchScript[];
			const scriptsByStep = new Map<number, PgbenchScript[]>();
			for (const ps of pgbenchScripts) {
				const arr = scriptsByStep.get(ps.step_id) ?? [];
				arr.push(ps);
				scriptsByStep.set(ps.step_id, arr);
			}
			const params = db.prepare('SELECT * FROM design_params WHERE design_id = ? ORDER BY position').all(design_id) as DesignParam[];

			let serverInfo = { host: '', port: 5432, username: '', password: '', database: design.database, ssl: false };
			if (design.server_id) {
				const srv = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(design.server_id) as PgServer | undefined;
				if (srv) serverInfo = { host: srv.host, port: srv.port, username: srv.username, password: srv.password, database: design.database, ssl: !!srv.ssl };
			}

			const enabledSnapTables: { pg_view_name: string; snap_table_name: string; columns: string[] }[] = [];
			if (design.server_id) {
				const enabled = db.prepare('SELECT table_name FROM pg_stat_table_selections WHERE server_id = ? AND enabled = 1').all(design.server_id) as { table_name: string }[];
				for (const { table_name } of enabled) {
					const snapTable = SNAP_TABLE_MAP[table_name];
					if (!snapTable) continue;
					let cols: string[] = [];
					try {
						cols = (db.prepare(`PRAGMA table_info(${snapTable})`).all() as { name: string }[]).map(r => r.name).filter(n => !EXCLUDED_SNAP_COLS.has(n));
					} catch { /* table not yet created */ }
					enabledSnapTables.push({ pg_view_name: table_name, snap_table_name: snapTable, columns: cols });
				}
			}

			const plan = {
				version: 1,
				exported_at: new Date().toISOString(),
				design_id: design.id,
				design_name: design.name,
				server: serverInfo,
				run_settings: { snapshot_interval_seconds: design.snapshot_interval_seconds, pre_collect_secs: design.pre_collect_secs, post_collect_secs: design.post_collect_secs },
				params: params.map(p => ({ name: p.name, value: p.value })),
				steps: steps.map(s => ({
					id: s.id, position: s.position, name: s.name, type: s.type, enabled: !!s.enabled,
					script: s.script, no_transaction: !!s.no_transaction, duration_secs: s.duration_secs,
					pgbench_options: s.pgbench_options,
					pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []).map(ps => ({ id: ps.id, name: ps.name, weight: ps.weight, script: ps.script })) : []
				})),
				enabled_snap_tables: enabledSnapTables
			};
			return text(plan);
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_db_schema
	// ─────────────────────────────────────────────────────────────────────────
	server.tool(
		'get_db_schema',
		`Queries the PostgreSQL database for the design's server and returns all tables with their columns and types.
Call this before writing SQL steps — you need real table and column names.
Returns tables in the "public" schema grouped by table name.`,
		{ design_id: z.number().int().describe('Design ID — used to look up the configured PG server') },
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT server_id, database FROM designs WHERE id = ?').get(design_id) as { server_id: number | null; database: string } | undefined;
			if (!design?.server_id) return text({ error: 'No server configured for this design. Set a server in the design settings first.' });

			const srv = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(design.server_id) as PgServer | undefined;
			if (!srv) return text({ error: `Server ${design.server_id} not found` });

			const pool = createPool(srv, design.database);
			try {
				const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(`
					SELECT table_name, column_name, data_type
					FROM information_schema.columns
					WHERE table_schema = 'public'
					ORDER BY table_name, ordinal_position
				`);
				const tables: Record<string, { name: string; type: string }[]> = {};
				for (const row of rows) {
					(tables[row.table_name] ??= []).push({ name: row.column_name, type: row.data_type });
				}
				return text({ database: design.database, tables });
			} finally {
				await pool.end().catch(() => {});
			}
		}
	);
}
