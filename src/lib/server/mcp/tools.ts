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
	server.registerTool(
		'get_context',
		{
			description: `Returns a complete guide to mybench. Call this first before using any other tool.
Covers: data model, database servers, step types, {{PARAM}} syntax, pgbench script format,
and the recommended workflow for creating and running a benchmark plan.`
		},
		async () => {
			const db = getDb();
			const servers = db.prepare('SELECT id, name, host, port, username, database, ssl FROM pg_servers ORDER BY id').all() as {
				id: number; name: string; host: string; port: number; username: string; database: string; ssl: number;
			}[];

			const guide = {
				overview: 'mybench helps you design and run PostgreSQL benchmarks. Use these tools to create plans, run tests, and export results.',
				database_servers: servers.length > 0
					? servers.map(s => ({ id: s.id, name: s.name, host: s.host, port: s.port, username: s.username, default_database: s.database, ssl: !!s.ssl }))
					: 'No servers configured yet. Add one in Settings (http://localhost:5173/settings) before running benchmarks.',
				data_model: {
					decisions: 'Top-level question you are answering (e.g. "Which table design is faster?"). Contains one or more designs.',
					designs: 'One candidate design to benchmark (e.g. "plain table" vs "partitioned table"). Each design is linked to a database server and has steps + params.',
					steps: 'Ordered list of actions: sql setup → collect pre-stats → pgbench load test → collect post-stats → sql teardown.',
					params: 'Named values (e.g. NUM_USERS=1000) substituted as {{NAME}} in all step scripts.'
				},
				step_types: {
					sql: {
						description: 'Runs a SQL script via psql. Use for CREATE TABLE, INSERT seed data, DROP TABLE, etc.',
						fields: {
							type: '"sql"',
							name: 'string',
							position: 'integer (execution order, 0-based)',
							script: 'SQL text (supports {{PARAM}})',
							no_transaction: 'boolean — if true, omit the --single-transaction wrapper',
							enabled: 'boolean'
						}
					},
					pgbench: {
						description: 'Runs a pgbench load test. Measures TPS, latency, and transactions.',
						fields: {
							type: '"pgbench"',
							name: 'string',
							position: 'integer',
							pgbench_options: 'e.g. "-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum --protocol=prepared"',
							pgbench_scripts: 'array of {name, weight, script} — pgbench custom script language (\\set, BEGIN, SQL, END)',
							enabled: 'boolean'
						},
						note: 'Supports {{PARAM}} substitution in pgbench_options and in each pgbench script.'
					},
					collect: {
						description: 'Takes periodic pg_stat_* snapshots for duration_secs seconds. Place before pgbench (pre phase) and after (post phase).',
						fields: {
							type: '"collect"',
							name: 'string',
							position: 'integer',
							duration_secs: 'integer — seconds to collect',
							enabled: 'boolean'
						}
					}
				},
				param_syntax: 'Write {{PARAM_NAME}} in any step script or pgbench_options. Set the value with set_params. Example: "INSERT INTO users SELECT generate_series(1, {{NUM_USERS}})"',
				design_server_assignment: 'When creating a design, the server_id and database must be set through the web UI (http://localhost:5173). Use get_db_schema(design_id) to verify the connection and see available tables before writing SQL.',
				recommended_workflow: [
					'1. get_context (this tool) — understand conventions and see available servers',
					'2. list_decisions — find existing decisions, or create_decision for a new one',
					'3. create_design(decision_id, name) — create a design candidate',
					'4. [assign server in web UI if needed, or reuse an existing design\'s server]',
					'5. get_db_schema(design_id) — see real table/column names from the live DB',
					'6. set_params(design_id, [{name, value}]) — define {{PARAM}} values',
					'7. upsert_step (repeat) — add sql setup, collect, pgbench, collect, sql teardown steps',
					'8. run_design(design_id) — start a test run, get run_id',
					'9. get_run(run_id) — poll until status is "completed" or "failed"',
					'10. export_plan(design_id) — get plan.json for production mybench-runner CLI'
				],
				example_steps: {
					sql_setup: {
						type: 'sql', name: 'Setup', position: 0, enabled: true,
						script: 'DROP TABLE IF EXISTS payments;\nCREATE TABLE payments (id BIGSERIAL PRIMARY KEY, user_id INT, amount INT);\nINSERT INTO payments (user_id, amount)\n  SELECT (random()*{{NUM_USERS}})::int, (random()*1000)::int\n  FROM generate_series(1, {{NUM_ROWS}});'
					},
					collect_pre: { type: 'collect', name: 'pre collect', position: 1, duration_secs: 15, enabled: true },
					pgbench: {
						type: 'pgbench', name: 'Benchmark', position: 2, enabled: true,
						pgbench_options: '-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum',
						pgbench_scripts: [{ name: 'main', weight: 1, script: '\\set uid random(1, {{NUM_USERS}})\nBEGIN;\nUPDATE payments SET amount = amount - 10 WHERE user_id = :uid;\nEND;' }]
					},
					collect_post: { type: 'collect', name: 'post collect', position: 3, duration_secs: 15, enabled: true },
					sql_teardown: { type: 'sql', name: 'Teardown', position: 4, script: 'DROP TABLE IF EXISTS payments;', enabled: true }
				}
			};
			return text(guide);
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// create_decision
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'create_decision',
		{
			description: 'Creates a new decision (the benchmarking question, e.g. "plain table vs partitioned table"). After creating, use create_design to add design candidates.',
			inputSchema: {
				name: z.string().describe('Short name for the decision, e.g. "payment table design"'),
				description: z.string().optional().describe('Longer description of what you are trying to decide')
			}
		},
		async ({ name, description }) => {
			const db = getDb();
			const result = db.prepare('INSERT INTO decisions (name, description) VALUES (?, ?)').run(name, description ?? '');
			return text({ decision_id: result.lastInsertRowid });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// list_decisions
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'list_decisions',
		{
			description: 'Lists all decisions and their designs. A decision is the benchmarking question; each design is one candidate answer to benchmark. Use this to find existing work before creating new decisions.'
		},
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
	server.registerTool(
		'get_design',
		{
			description: 'Returns a design with all its steps, pgbench scripts, and params. Use this to inspect an existing design before modifying it.',
			inputSchema: {
				design_id: z.number().int().describe('Design ID from list_decisions')
			}
		},
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
			return text({ ...design, steps: steps.map(s => ({ ...s, pgbench_scripts: scriptsByStep.get(s.id) ?? [] })), params });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// create_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'create_design',
		{
			description: 'Creates a new design under a decision. A design is one candidate to benchmark. After creating, use upsert_step to add steps and set_params to define parameters. Assign a database server via the web UI or by copying one from an existing design.',
			inputSchema: {
				decision_id: z.number().int().describe('Decision ID from list_decisions'),
				name: z.string().describe('Short name, e.g. "plain table" or "partitioned"'),
				description: z.string().optional().describe('Optional longer description')
			}
		},
		async ({ decision_id, name, description }) => {
			const db = getDb();
			const result = db.prepare('INSERT INTO designs (decision_id, name, description) VALUES (?, ?, ?)').run(decision_id, name, description ?? '');
			return text({ design_id: result.lastInsertRowid });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// upsert_step
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'upsert_step',
		{
			description: `Adds a new step or updates an existing step in a design. If step_id is provided, updates that step; otherwise inserts a new one.
Step types:
  "sql"     — provide script (SQL text, supports {{PARAM}})
  "pgbench" — provide pgbench_options and pgbench_scripts [{name, weight, script}]
  "collect" — provide duration_secs (seconds to collect pg_stat_* snapshots)
Use {{PARAM_NAME}} in scripts and pgbench_options — values come from set_params.`,
			inputSchema: {
				design_id: z.number().int(),
				step_id: z.number().int().optional().describe('Omit to insert a new step'),
				type: z.enum(['sql', 'pgbench', 'collect']),
				name: z.string(),
				position: z.number().int().describe('Execution order, 0-based. Lower = runs earlier.'),
				enabled: z.boolean().default(true),
				script: z.string().optional().describe('SQL text for type=sql'),
				no_transaction: z.boolean().optional().describe('If true, SQL runs without wrapping in a transaction'),
				pgbench_options: z.string().optional().describe('pgbench CLI flags, e.g. "-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum"'),
				pgbench_scripts: z.array(z.object({
					name: z.string(),
					weight: z.number().int().default(1),
					script: z.string().describe('pgbench custom script: use \\set, BEGIN, SQL, END. Supports {{PARAM}}.')
				})).optional().describe('Required for type=pgbench'),
				duration_secs: z.number().int().optional().describe('Snapshot collection duration for type=collect')
			}
		},
		async ({ design_id, step_id, type, name, position, enabled, script, no_transaction, pgbench_options, pgbench_scripts, duration_secs }) => {
			const db = getDb();
			let resolvedStepId: number;
			if (step_id) {
				db.prepare('UPDATE design_steps SET type=?, name=?, position=?, enabled=?, script=?, no_transaction=?, pgbench_options=?, duration_secs=? WHERE id=?')
					.run(type, name, position, enabled ? 1 : 0, script ?? '', no_transaction ? 1 : 0, pgbench_options ?? '', duration_secs ?? 0, step_id);
				resolvedStepId = step_id;
			} else {
				const r = db.prepare('INSERT INTO design_steps (design_id, type, name, position, enabled, script, no_transaction, pgbench_options, duration_secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
					.run(design_id, type, name, position, enabled ? 1 : 0, script ?? '', no_transaction ? 1 : 0, pgbench_options ?? '', duration_secs ?? 0);
				resolvedStepId = r.lastInsertRowid as number;
			}
			if (type === 'pgbench' && pgbench_scripts) {
				db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?').run(resolvedStepId);
				const ins = db.prepare('INSERT INTO pgbench_scripts (step_id, position, name, weight, script) VALUES (?, ?, ?, ?, ?)');
				pgbench_scripts.forEach((ps, i) => ins.run(resolvedStepId, i, ps.name, ps.weight, ps.script));
			}
			return text({ step_id: resolvedStepId, action: step_id ? 'updated' : 'created' });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// delete_step
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'delete_step',
		{
			description: 'Deletes a step and its associated pgbench scripts. Use get_design to find the step_id first.',
			inputSchema: { step_id: z.number().int() }
		},
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
	server.registerTool(
		'set_params',
		{
			description: `Replaces all parameters for a design. Parameters are substituted as {{NAME}} in step scripts and pgbench_options.
Pass the complete list — this replaces existing params, not merges.
Tip: use descriptive names like NUM_USERS, NUM_ROWS, NUM_CLIENTS, DURATION_SECS.`,
			inputSchema: {
				design_id: z.number().int(),
				params: z.array(z.object({
					name: z.string().describe('Used as {{NAME}} in scripts'),
					value: z.string().describe('Default value (can be overridden with --param on mybench-runner CLI)')
				}))
			}
		},
		async ({ design_id, params }) => {
			const db = getDb();
			db.transaction(() => {
				db.prepare('DELETE FROM design_params WHERE design_id = ?').run(design_id);
				const ins = db.prepare('INSERT INTO design_params (design_id, position, name, value) VALUES (?, ?, ?, ?)');
				params.forEach((p, i) => ins.run(design_id, i, p.name, p.value));
			})();
			return text({ set: params.length, design_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// run_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'run_design',
		{
			description: `Starts a benchmark run for a design. Returns run_id immediately — poll get_run(run_id) until status is "completed" or "failed".
Executes all enabled steps in order: sql setup → pre-collect → pgbench → post-collect → sql teardown.
This is a validation/test run. For production benchmarking, use export_plan + mybench-runner on EC2.`,
			inputSchema: { design_id: z.number().int() }
		},
		async ({ design_id }) => {
			const runId = startRun(design_id);
			return text({ run_id: runId, message: 'Run started. Poll get_run(run_id) for status.' });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_run
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'get_run',
		{
			description: `Returns the current status and results of a benchmark run. Poll this after run_design.
status: "running" | "completed" | "failed" | "stopped"
When completed: tps, latency_avg_ms, latency_stddev_ms, and transactions are populated.`,
			inputSchema: { run_id: z.number().int() }
		},
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
	server.registerTool(
		'export_plan',
		{
			description: `Returns the plan.json for a design — the input file for mybench-runner on EC2.
Contains: server config, all enabled steps + scripts, params, and pg_stat table specs.
Use this after validating the plan with run_design.`,
			inputSchema: { design_id: z.number().int() }
		},
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
					try { cols = (db.prepare(`PRAGMA table_info(${snapTable})`).all() as { name: string }[]).map(r => r.name).filter(n => !EXCLUDED_SNAP_COLS.has(n)); } catch { /* not yet created */ }
					enabledSnapTables.push({ pg_view_name: table_name, snap_table_name: snapTable, columns: cols });
				}
			}

			return text({
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
			});
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// get_db_schema
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'get_db_schema',
		{
			description: `Queries the live PostgreSQL database for the design's server and returns all tables with their columns and types.
Call this before writing SQL steps — you need the real table and column names.
Returns tables in the "public" schema. If no server is configured for the design, set one in the web UI first.`,
			inputSchema: { design_id: z.number().int().describe('Design ID — used to look up the configured PG server') }
		},
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT server_id, database FROM designs WHERE id = ?').get(design_id) as { server_id: number | null; database: string } | undefined;
			if (!design?.server_id) return text({ error: 'No server configured for this design. Set a server in the web UI (http://localhost:5173) first.' });

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
				for (const row of rows) (tables[row.table_name] ??= []).push({ name: row.column_name, type: row.data_type });
				return text({ database: design.database, server: srv.name, tables });
			} finally {
				await pool.end().catch(() => {});
			}
		}
	);
}
