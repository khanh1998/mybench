import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRunnablePgbenchScripts } from '$lib/params';
import getDb from '$lib/server/db';
import { createPool } from '$lib/server/pg-client';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import { startRun } from '$lib/server/run-executor';
import type { PgServer, DesignStep, PgbenchScript, DesignParam } from '$lib/types';

const EXCLUDED_SNAP_COLS = new Set(['_id', '_run_id', '_collected_at', '_phase', '_is_baseline', '_step_id']);

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
			const servers = db.prepare('SELECT id, name, host, port, username, ssl FROM pg_servers ORDER BY id').all() as {
				id: number; name: string; host: string; port: number; username: string; ssl: number;
			}[];

			const guide = {
				overview: 'mybench helps you design and run PostgreSQL benchmarks. Use these tools to create plans, run tests, and export results.',
				database_servers: servers.length > 0
					? servers.map(s => ({ id: s.id, name: s.name, host: s.host, port: s.port, username: s.username, ssl: !!s.ssl }))
					: 'No servers configured yet. Add one in Settings (http://localhost:5173/settings) before running benchmarks.',
				data_model: {
					decisions: 'Top-level question you are answering (e.g. "Which table design is faster?"). Contains one or more designs.',
					designs: 'One candidate design to benchmark (e.g. "plain table" vs "partitioned table"). Each design is linked to a database server and has steps + params.',
					steps: 'Ordered list of actions: sql setup → wait for pre-stats → optional pg_stat_statements reset → pgbench load test → optional pg_stat_statements collect → wait for post-stats → sql teardown.',
					params: 'Named values (e.g. NUM_USERS=1000) substituted as {{NAME}} in all step scripts.',
					profiles: 'Named sets of param overrides (e.g. "small"=NUM_USERS:100, "large"=NUM_USERS:10000) for running the same design at different scales. Managed with upsert_profile/list_profiles/delete_profile.'
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
						description: 'Waits for duration_secs seconds while taking periodic pg_stat_* snapshots. Place before pgbench for a baseline window or after pgbench for a post-run window.',
						fields: {
							type: '"collect"',
							name: 'string',
							position: 'integer',
							duration_secs: 'integer — seconds to wait while collecting snapshots',
							enabled: 'boolean'
						}
					},
					pg_stat_statements_reset: {
						description: 'Resets pg_stat_statements before a benchmark. Use right before pgbench when you want query-level stats to start from zero.',
						fields: {
							type: '"pg_stat_statements_reset"',
							name: 'string',
							position: 'integer',
							enabled: 'boolean'
						},
						note: 'If pg_stat_statements is unavailable or cannot be reset, mybench logs a warning and continues.'
					},
					pg_stat_statements_collect: {
						description: 'Captures a single pg_stat_statements snapshot for the current benchmark database. Place after pgbench.',
						fields: {
							type: '"pg_stat_statements_collect"',
							name: 'string',
							position: 'integer',
							enabled: 'boolean'
						},
						note: 'This is a one-time snapshot, not a duration-based time series collect step.'
					}
				},
				param_syntax: 'Write {{PARAM_NAME}} in any step script or pgbench_options. Set the value with set_params. Example: "INSERT INTO users SELECT generate_series(1, {{NUM_USERS}})"',
				design_server_assignment: 'When creating a design, the server_id and database must be set through the web UI (http://localhost:5173). Use get_db_schema(design_id) to verify the connection and see available tables before writing SQL.',
				recommended_workflow: [
					'1. get_context (this tool) — understand conventions and see available servers',
					'2. list_decisions — find existing decisions, or create_decision for a new one',
					'3. create_design(decision_id, name) — create a design candidate',
					'4. configure_design(design_id, {server_id, database}) — assign a server from the database_servers list',
					'5. get_db_schema(design_id) — see real table/column names from the live DB',
					'6. set_params(design_id, [{name, value}]) — define {{PARAM}} values',
					'7. upsert_step (repeat) — add sql setup, wait, optional pg_stat_statements reset, pgbench, optional pg_stat_statements collect, wait, sql teardown steps',
					'8. upsert_profile(design_id, name, values) — optional: create "small"/"large" profiles for different scales',
					'9. validate_design(design_id) — check for issues (undefined params, missing server, no pgbench step) before running',
					'10. run_design(design_id, profile_id?) — start a test run (optionally with a profile), get run_id',
					'11. get_run(run_id) — wait ~(pgbench -T seconds + collect durations) before first poll, then every ~30s',
					'12. export_plan(design_id) — get plan.json for production mybench-runner CLI'
				],
				recommended_step_structure: {
					description: 'Always follow this 10-step order when building a benchmark design. Each step has a specific purpose — do not skip or merge steps.',
					steps: [
						{
							position: 0, type: 'sql',
							name: '1 — Init schema (no indexes/constraints)',
							purpose: 'Create tables in their bare form: no indexes, no CHECK, no FOREIGN KEY, no UNIQUE (except PK). Maximises INSERT throughput during seeding.',
							tip: 'Use UNLOGGED tables if crash-safety is not needed during setup — convert to LOGGED in step 3.',
							example: 'DROP TABLE IF EXISTS orders CASCADE;\nCREATE UNLOGGED TABLE orders (\n  id BIGSERIAL PRIMARY KEY,\n  user_id BIGINT,\n  total NUMERIC\n);'
						},
						{
							position: 1, type: 'sql',
							name: '2 — Seed data',
							purpose: 'Bulk-insert the realistic dataset using generate_series or COPY. Insert without constraint overhead from step 1.',
							tip: 'Use {{NUM_ROWS}}, {{NUM_USERS}} params so profiles can scale the dataset. Emit RAISE NOTICE every 100k rows for progress.',
							example: 'INSERT INTO orders (user_id, total)\n  SELECT (random()*{{NUM_USERS}})::bigint,\n         (random()*10000)::numeric\n  FROM generate_series(1, {{NUM_ROWS}});'
						},
						{
							position: 2, type: 'sql',
							name: '3 — Add indexes, constraints, foreign keys',
							purpose: 'Add all indexes, CHECK, FOREIGN KEY, and UNIQUE constraints now. Building them after bulk-insert is far faster than maintaining them row-by-row.',
							tip: 'If the table was UNLOGGED, convert it here: ALTER TABLE orders SET LOGGED;',
							example: 'ALTER TABLE orders SET LOGGED;\nALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);\nCREATE INDEX ON orders (user_id);\nCREATE INDEX ON orders (created_at DESC);'
						},
						{
							position: 3, type: 'sql', no_transaction: true,
							name: '4 — Maintenance (VACUUM, ANALYZE, CHECKPOINT, warm buffers)',
							purpose: 'Bring the database to a clean, production-like state. Eliminates noise from dead tuples, stale stats, or cold buffers.',
							tip: 'Must use no_transaction: true — VACUUM and CHECKPOINT cannot run inside a transaction. Warm the buffer pool with a full seqscan on hot tables.',
							example: 'VACUUM ANALYZE orders;\nVACUUM ANALYZE users;\nCHECKPOINT;\n-- Warm buffer pool\nSELECT COUNT(*) FROM orders;\nSELECT COUNT(*) FROM users;'
						},
						{
							position: 4, type: 'sql',
							name: '5 — Table sizes before benchmark',
							purpose: 'Snapshot table and index sizes before load so you can measure write amplification and bloat caused by the benchmark.',
							example: "SELECT relname,\n       pg_size_pretty(pg_total_relation_size(oid)) AS total,\n       pg_size_pretty(pg_relation_size(oid)) AS heap,\n       pg_size_pretty(pg_indexes_size(oid)) AS indexes\nFROM pg_class\nWHERE relname IN ('orders','users')\nORDER BY relname;"
						},
						{
							position: 5, type: 'collect', duration_secs: 15,
							name: '6 — Wait before benchmark',
							purpose: 'Wait while taking pg_stat_* baseline snapshots before load. The delta (post − pre) reveals cache hit rate, index usage, I/O, and WAL volume caused by the benchmark. Can be disabled if not needed.'
						},
						{
							position: 6, type: 'pgbench',
							name: '7 — Benchmark',
							purpose: 'The actual load test. Script weights must sum to ≤ 100. Use --no-vacuum to prevent pgbench from running its own VACUUM during the test.',
							tip: 'Model a realistic read/write mix with multiple scripts and weights. {{NUM_CLIENTS}}, {{NUM_THREADS}}, {{DURATION_SECS}} are the key params.',
							example_options: '-c {{NUM_CLIENTS}} -j {{NUM_THREADS}} -T {{DURATION_SECS}} --no-vacuum',
							example_scripts: [
								{ name: 'write', weight: 30, script: '\\set uid random(1, {{NUM_USERS}})\nBEGIN;\nINSERT INTO orders (user_id, total) VALUES (:uid, random()*1000);\nEND;' },
								{ name: 'read', weight: 70, script: '\\set uid random(1, {{NUM_USERS}})\nSELECT * FROM orders WHERE user_id = :uid LIMIT 10;' }
							]
						},
						{
							position: 7, type: 'collect', duration_secs: 15,
							name: '8 — Wait after benchmark',
							purpose: 'Wait while taking pg_stat_* snapshots after load. Compare with the pre-run wait step to see the impact of the benchmark on cache, I/O, WAL, and index usage.'
						},
						{
							position: 8, type: 'sql',
							name: '9 — Table sizes after benchmark',
							purpose: 'Re-run the same size query from step 5. Compare before/after to measure index bloat, heap growth, and TOAST expansion caused by writes.',
							example: "SELECT relname,\n       pg_size_pretty(pg_total_relation_size(oid)) AS total,\n       pg_size_pretty(pg_relation_size(oid)) AS heap,\n       pg_size_pretty(pg_indexes_size(oid)) AS indexes\nFROM pg_class\nWHERE relname IN ('orders','users')\nORDER BY relname;"
						},
						{
							position: 9, type: 'sql',
							name: '10 — Teardown',
							purpose: 'Drop all tables created in step 1. Use CASCADE to handle foreign keys. Leave the database clean for the next run.',
							example: 'DROP TABLE IF EXISTS orders CASCADE;\nDROP TABLE IF EXISTS users CASCADE;'
						}
					]
				},
				example_steps: {
					sql_setup: {
						type: 'sql', name: 'Setup', position: 0, enabled: true,
						script: 'DROP TABLE IF EXISTS payments;\nCREATE TABLE payments (id BIGSERIAL PRIMARY KEY, user_id INT, amount INT);\nINSERT INTO payments (user_id, amount)\n  SELECT (random()*{{NUM_USERS}})::int, (random()*1000)::int\n  FROM generate_series(1, {{NUM_ROWS}});'
					},
					collect_pre: { type: 'collect', name: 'wait before benchmark', position: 1, duration_secs: 15, enabled: true },
					pg_stat_statements_reset: { type: 'pg_stat_statements_reset', name: 'reset pg_stat_statements', position: 2, enabled: true },
					pgbench: {
						type: 'pgbench', name: 'Benchmark', position: 3, enabled: true,
						pgbench_options: '-c {{NUM_CLIENTS}} -j 2 -T 60 --no-vacuum',
						pgbench_scripts: [{ name: 'main', weight: 1, script: '\\set uid random(1, {{NUM_USERS}})\nBEGIN;\nUPDATE payments SET amount = amount - 10 WHERE user_id = :uid;\nEND;' }]
					},
					pg_stat_statements_collect: { type: 'pg_stat_statements_collect', name: 'collect pg_stat_statements', position: 4, enabled: true },
					collect_post: { type: 'collect', name: 'wait after benchmark', position: 5, duration_secs: 15, enabled: true },
					sql_teardown: { type: 'sql', name: 'Teardown', position: 6, script: 'DROP TABLE IF EXISTS payments;', enabled: true }
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
			description: 'Creates a new design under a decision. A design is one candidate to benchmark. After creating, use configure_design to set the server and database, then upsert_step and set_params.',
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
	// configure_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'configure_design',
		{
			description: `Updates the configuration of an existing design: server, database, description, and snapshot settings.
Use get_context to see available server IDs. All fields are optional — only provided fields are updated.
Call this after create_design to assign a server before running the design.`,
			inputSchema: {
				design_id: z.number().int(),
				server_id: z.number().int().optional().describe('PG server ID from get_context database_servers list'),
				database: z.string().optional().describe('Database name on the server to benchmark against'),
				description: z.string().optional().describe('Human-readable description of this design'),
				snapshot_interval_seconds: z.number().int().optional().describe('How often to take pg_stat_* snapshots during benchmarks (default 30)'),
				pre_collect_secs: z.number().int().optional().describe('Seconds of pg_stat collection before pgbench (legacy, prefer collect steps)'),
				post_collect_secs: z.number().int().optional().describe('Seconds of pg_stat collection after pgbench (legacy, prefer collect steps)')
			}
		},
		async ({ design_id, server_id, database, description, snapshot_interval_seconds, pre_collect_secs, post_collect_secs }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id);
			if (!design) return text({ error: `Design ${design_id} not found` });

			const fields: string[] = [];
			const values: unknown[] = [];
			if (server_id !== undefined)              { fields.push('server_id = ?');              values.push(server_id); }
			if (database !== undefined)               { fields.push('database = ?');               values.push(database); }
			if (description !== undefined)            { fields.push('description = ?');            values.push(description); }
			if (snapshot_interval_seconds !== undefined) { fields.push('snapshot_interval_seconds = ?'); values.push(snapshot_interval_seconds); }
			if (pre_collect_secs !== undefined)       { fields.push('pre_collect_secs = ?');       values.push(pre_collect_secs); }
			if (post_collect_secs !== undefined)      { fields.push('post_collect_secs = ?');      values.push(post_collect_secs); }

			if (fields.length === 0) return text({ message: 'Nothing to update — no fields provided.' });

			values.push(design_id);
			db.prepare(`UPDATE designs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

			return text({ updated: true, design_id, fields: fields.map(f => f.split(' ')[0]) });
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
  "collect" — provide duration_secs (seconds to wait while collecting pg_stat_* snapshots)
  "pg_stat_statements_reset"   — no extra fields; resets pg_stat_statements and logs a warning if unavailable
  "pg_stat_statements_collect" — no extra fields; captures one pg_stat_statements snapshot for the current database
Use {{PARAM_NAME}} in scripts and pgbench_options — values come from set_params.`,
			inputSchema: {
				design_id: z.number().int(),
				step_id: z.number().int().optional().describe('Omit to insert a new step'),
				type: z.enum(['sql', 'pgbench', 'collect', 'pg_stat_statements_reset', 'pg_stat_statements_collect']),
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
	// upsert_profile
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'upsert_profile',
		{
			description: 'Creates or updates a named parameter profile for a design. Profiles let you run the same design at different scales (e.g. small/medium/large). Omit profile_id to create; provide it to update.',
			inputSchema: {
				design_id: z.number().int(),
				profile_id: z.number().int().optional().describe('Omit to create a new profile'),
				name: z.string().describe('Profile name, e.g. "small", "medium", "large"'),
				values: z.array(z.object({
					param_name: z.string().describe('Param name (must match a design param)'),
					value: z.string().describe('Override value for this profile')
				})).describe('Only include params you want to override from their defaults')
			}
		},
		async ({ design_id, profile_id, name, values }) => {
			const db = getDb();
			if (profile_id) {
				const profile = db.prepare('SELECT id FROM design_param_profiles WHERE id = ? AND design_id = ?').get(profile_id, design_id);
				if (!profile) return text({ error: `Profile ${profile_id} not found for design ${design_id}` });
				db.transaction(() => {
					db.prepare('UPDATE design_param_profiles SET name = ? WHERE id = ?').run(name, profile_id);
					db.prepare('DELETE FROM design_param_profile_values WHERE profile_id = ?').run(profile_id);
					const ins = db.prepare('INSERT INTO design_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
					for (const v of values) ins.run(profile_id, v.param_name, v.value);
				})();
				return text({ updated: true, profile_id });
			} else {
				const r = db.transaction(() => {
					const res = db.prepare('INSERT INTO design_param_profiles (design_id, name) VALUES (?, ?)').run(design_id, name);
					const newId = res.lastInsertRowid as number;
					const ins = db.prepare('INSERT INTO design_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
					for (const v of values) ins.run(newId, v.param_name, v.value);
					return newId;
				})();
				return text({ created: true, profile_id: r });
			}
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// list_profiles
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'list_profiles',
		{
			description: 'Lists all parameter profiles for a design, including their value overrides.',
			inputSchema: { design_id: z.number().int() }
		},
		async ({ design_id }) => {
			const db = getDb();
			const profiles = db.prepare('SELECT * FROM design_param_profiles WHERE design_id = ? ORDER BY id').all(design_id) as { id: number; design_id: number; name: string }[];
			const values = db.prepare('SELECT * FROM design_param_profile_values WHERE profile_id IN (SELECT id FROM design_param_profiles WHERE design_id = ?) ORDER BY profile_id, id').all(design_id) as { profile_id: number; param_name: string; value: string }[];
			const byProfile = new Map<number, { param_name: string; value: string }[]>();
			for (const v of values) {
				const arr = byProfile.get(v.profile_id) ?? [];
				arr.push({ param_name: v.param_name, value: v.value });
				byProfile.set(v.profile_id, arr);
			}
			return text(profiles.map(p => ({ ...p, values: byProfile.get(p.id) ?? [] })));
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// delete_profile
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'delete_profile',
		{
			description: 'Deletes a parameter profile by ID.',
			inputSchema: { profile_id: z.number().int() }
		},
		async ({ profile_id }) => {
			const db = getDb();
			db.prepare('DELETE FROM design_param_profiles WHERE id = ?').run(profile_id);
			return text({ deleted: true, profile_id });
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// validate_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'validate_design',
		{
			description: `Validates a design and returns a list of issues that would prevent it from running correctly.
Checks performed:
  - No server configured
  - No database set
  - No enabled steps
  - No enabled pgbench step (nothing to benchmark)
  - pgbench step with no scripts defined
  - wait step with duration_secs = 0
  - {{PARAM}} placeholders used in scripts/options but not defined in design params
  - Defined params with empty values
Call this before run_design or export_plan to catch problems early.`,
			inputSchema: {
				design_id: z.number().int().describe('Design ID to validate')
			}
		},
		async ({ design_id }) => {
			const db = getDb();
			const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(design_id) as {
				id: number; name: string; server_id: number | null; database: string;
			} | undefined;
			if (!design) return text({ error: `Design ${design_id} not found` });

			const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(design_id) as DesignStep[];
			const pgbenchScripts = db.prepare('SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position').all(design_id) as PgbenchScript[];
			const params = db.prepare('SELECT * FROM design_params WHERE design_id = ? ORDER BY position').all(design_id) as DesignParam[];

			const scriptsByStep = new Map<number, PgbenchScript[]>();
			for (const ps of pgbenchScripts) {
				const arr = scriptsByStep.get(ps.step_id) ?? [];
				arr.push(ps);
				scriptsByStep.set(ps.step_id, arr);
			}

			const issues: { severity: 'error' | 'warning'; code: string; message: string }[] = [];

			// Server and database checks
			if (!design.server_id) {
				issues.push({ severity: 'error', code: 'NO_SERVER', message: 'No PostgreSQL server configured. Use configure_design to set server_id, or set one in the web UI.' });
			}
			if (!design.database || design.database.trim() === '') {
				issues.push({ severity: 'error', code: 'NO_DATABASE', message: 'No database name configured. Use configure_design to set database.' });
			}

			// Step checks
			const enabledSteps = steps.filter(s => s.enabled);
			if (enabledSteps.length === 0) {
				issues.push({ severity: 'error', code: 'NO_ENABLED_STEPS', message: 'No enabled steps. Enable at least one step before running.' });
			} else {
				const hasPgbench = enabledSteps.some(s => s.type === 'pgbench');
				if (!hasPgbench) {
					issues.push({ severity: 'warning', code: 'NO_PGBENCH_STEP', message: 'No enabled pgbench step. The run will execute but produce no benchmark metrics (TPS, latency).' });
				}

				for (const step of enabledSteps) {
					if (step.type === 'pgbench') {
						const scripts = scriptsByStep.get(step.id) ?? [];
						const runnableScripts = getRunnablePgbenchScripts(scripts);
						if (runnableScripts.length === 0) {
							const message = scripts.length === 0
								? `pgbench step "${step.name}" has no scripts defined. It will run pgbench's built-in TPC-B scenario instead.`
								: `pgbench step "${step.name}" has no active scripts because all weights are 0. It will run pgbench's built-in TPC-B scenario instead.`;
							issues.push({ severity: 'warning', code: 'PGBENCH_NO_SCRIPTS', message });
						} else {
							const totalWeight = runnableScripts.reduce((sum, ps) => sum + (ps.weight ?? 1), 0);
							if (totalWeight > 100) {
								issues.push({ severity: 'error', code: 'PGBENCH_WEIGHT_EXCEEDS_100', message: `pgbench step "${step.name}" has scripts with a total weight of ${totalWeight}. Total weight must not exceed 100.` });
							}
						}
					}
					if (step.type === 'collect' && (!step.duration_secs || step.duration_secs <= 0)) {
						issues.push({ severity: 'warning', code: 'COLLECT_ZERO_DURATION', message: `wait step "${step.name}" has duration_secs = 0. It will use the design-level pre/post collect settings.` });
					}
				}
			}

			// Param placeholder checks
			const definedParams = new Set(params.map(p => p.name).filter(Boolean));
			const placeholderPattern = /\{\{([\w]+)\}\}/g;

			for (const step of enabledSteps) {
				const textsToCheck: { label: string; text: string }[] = [];

				if (step.type === 'sql' && step.script) {
					textsToCheck.push({ label: `script`, text: step.script });
				}
				if (step.type === 'pgbench') {
					if (step.pgbench_options) textsToCheck.push({ label: `pgbench_options`, text: step.pgbench_options });
					for (const ps of getRunnablePgbenchScripts(scriptsByStep.get(step.id) ?? [])) {
						textsToCheck.push({ label: `script "${ps.name}"`, text: ps.script });
					}
				}

				for (const { label, text: scriptText } of textsToCheck) {
					const matches = [...scriptText.matchAll(placeholderPattern)].map(m => m[1]);
					for (const ph of matches) {
						if (!definedParams.has(ph)) {
							issues.push({
								severity: 'error',
								code: 'UNDEFINED_PARAM',
								message: `Step "${step.name}" ${label} uses {{${ph}}} but this param is not defined. Add it with set_params.`
							});
						}
					}
				}
			}

			// Param value checks
			for (const p of params) {
				if (!p.value || p.value.trim() === '') {
					issues.push({ severity: 'warning', code: 'EMPTY_PARAM_VALUE', message: `Param "${p.name}" has an empty value. Steps using {{${p.name}}} will substitute an empty string.` });
				}
			}

			const errorCount = issues.filter(i => i.severity === 'error').length;
			const warningCount = issues.filter(i => i.severity === 'warning').length;

			return text({
				design_id,
				design_name: design.name,
				valid: errorCount === 0,
				summary: errorCount === 0 && warningCount === 0
					? 'No issues found. Design is ready to run.'
					: `${errorCount} error(s), ${warningCount} warning(s) found.`,
				issues
			});
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// run_design
	// ─────────────────────────────────────────────────────────────────────────
	server.registerTool(
		'run_design',
		{
			description: `Starts a benchmark run for a design. Returns run_id immediately — poll get_run(run_id) until status is "completed" or "failed".
Executes all enabled steps in order: sql setup → wait → pgbench → wait → sql teardown.
Optional query-level steps can be inserted anywhere: pg_stat_statements_reset and pg_stat_statements_collect.
This is a validation/test run. For production benchmarking, use export_plan + mybench-runner on EC2.

Polling strategy: before polling, estimate total run duration from the design steps:
- For each pgbench step: parse the -T <seconds> flag from pgbench_options (e.g. "-T 60" → 60s)
- For each wait step: add duration_secs
- Sum all steps, then wait that long before the first get_run call
- If still "running", poll every ~30s thereafter
Example: pgbench -T 120 + two 15s wait steps → wait ~150s before first poll.`,
			inputSchema: {
				design_id: z.number().int(),
				profile_id: z.number().int().optional().describe('Optional profile ID to apply param overrides'),
				name: z.string().optional().describe('Optional run name; defaults to profile name if a profile is used')
			}
		},
		async ({ design_id, profile_id, name }) => {
			const runId = startRun(design_id, { profile_id, name });
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
When completed: tps, latency_avg_ms, latency_stddev_ms, and transactions are populated.

Do NOT poll rapidly. Estimate the run duration first (see run_design description), wait that long,
then poll every ~30s if still running. Rapid polling wastes resources and does not speed up the run.`,
			inputSchema: { run_id: z.number().int() }
		},
		async ({ run_id }) => {
			const db = getDb();
			const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(run_id) as Record<string, unknown> | undefined;
			if (!run) return text({ error: `Run ${run_id} not found` });
			// Parse run_params from JSON string for easier consumption
			const runParams = run.run_params && typeof run.run_params === 'string' && run.run_params !== ''
				? (() => { try { return JSON.parse(run.run_params as string); } catch { return []; } })()
				: [];
			return text({ ...run, run_params: runParams });
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

			const profileRows = db.prepare('SELECT * FROM design_param_profiles WHERE design_id = ? ORDER BY id').all(design_id) as { id: number; name: string }[];
			const profileValueRows = db.prepare('SELECT * FROM design_param_profile_values WHERE profile_id IN (SELECT id FROM design_param_profiles WHERE design_id = ?) ORDER BY profile_id, id').all(design_id) as { profile_id: number; param_name: string; value: string }[];
			const profileValuesById = new Map<number, { param_name: string; value: string }[]>();
			for (const v of profileValueRows) {
				const arr = profileValuesById.get(v.profile_id) ?? [];
				arr.push({ param_name: v.param_name, value: v.value });
				profileValuesById.set(v.profile_id, arr);
			}
			const profiles = profileRows.map(p => ({ name: p.name, values: profileValuesById.get(p.id) ?? [] }));

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
			if (steps.some((step) => step.type === 'pg_stat_statements_collect')) {
				let cols: string[] = [];
				try {
					cols = (db.prepare(`PRAGMA table_info(snap_pg_stat_statements)`).all() as { name: string }[])
						.map((r) => r.name)
						.filter((n) => !EXCLUDED_SNAP_COLS.has(n));
				} catch {
					// table not yet created
				}
				enabledSnapTables.push({
					pg_view_name: 'pg_stat_statements',
					snap_table_name: 'snap_pg_stat_statements',
					columns: cols
				});
			}

			return text({
				version: 1,
				exported_at: new Date().toISOString(),
				design_id: design.id,
				design_name: design.name,
				server: serverInfo,
				run_settings: { snapshot_interval_seconds: design.snapshot_interval_seconds, pre_collect_secs: design.pre_collect_secs, post_collect_secs: design.post_collect_secs },
				params: params.map(p => ({ name: p.name, value: p.value })),
				profiles,
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
