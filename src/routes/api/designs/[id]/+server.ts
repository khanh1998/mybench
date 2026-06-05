import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';
import type { PgbenchScript, DesignParam } from '$lib/types';

export const GET: RequestHandler = ({ params: routeParams }) => {
	const db = getDb();
	const designId = Number(routeParams.id);
	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId);
	if (!design) throw error(404, 'Not found');
	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(designId) as { id: number; type: string; [key: string]: unknown }[];
	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position'
	).all(designId) as PgbenchScript[];

	const scriptsByStep = new Map<number, PgbenchScript[]>();
	for (const ps of pgbenchScripts) {
		const arr = scriptsByStep.get(ps.step_id) ?? [];
		arr.push(ps);
		scriptsByStep.set(ps.step_id, arr);
	}

	const stepsWithScripts = steps.map(s => ({
		...s,
		pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []) : undefined
	}));

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(designId) as DesignParam[];

	return json({ ...design as object, steps: stepsWithScripts, params: designParams });
};

export const PUT: RequestHandler = async ({ params: routeParams, request }) => {
	const db = getDb();
	const designId = Number(routeParams.id);
	const body = await request.json();
	db.prepare(
		'UPDATE designs SET name=?, description=?, server_id=?, database=?, pre_collect_secs=?, post_collect_secs=?, snapshot_interval_seconds=? WHERE id=?'
	).run(body.name, body.description ?? '', body.server_id ?? null, body.database ?? '', body.pre_collect_secs ?? 0, body.post_collect_secs ?? 60, body.snapshot_interval_seconds ?? 30, designId);

	const deleteScripts = db.prepare('DELETE FROM pgbench_scripts WHERE step_id = ?');
	const insertScript = db.prepare(
		'INSERT INTO pgbench_scripts (step_id, position, name, weight, weight_expr, script) VALUES (?, ?, ?, ?, ?, ?)'
	);
	const deleteParams = db.prepare('DELETE FROM design_params WHERE design_id = ?');
	const insertParam = db.prepare(
		'INSERT INTO design_params (design_id, position, name, value) VALUES (?, ?, ?, ?)'
	);

	if (body.steps) {
		const upsert = db.prepare(
			`INSERT INTO design_steps (
				 id, design_id, position, name, type, script, pgbench_options, enabled,
				 duration_secs, no_transaction, collect_perf, perf_duration,
				 perf_stat_duration, perf_record_duration, perf_trace_duration,
				 perf_stat_enabled, perf_record_enabled, perf_trace_enabled, perf_delay,
				 perf_stat_delay, perf_record_delay, perf_trace_delay,
				 perf_cgroup, perf_events, perf_repeat, perf_freq, perf_call_graph, perf_mmap_pages,
				 pg_stat_tables, pg_stat_interval_seconds, pg_stat_pg_locks_enabled,
				 pg_stat_pg_locks_interval, pg_stat_reset_stats, pg_stat_reset_statements,
				 pg_stat_collect_statements,
				 proc_groups, proc_interval_seconds
			 )
       VALUES (
				 @id, @design_id, @position, @name, @type, @script, @pgbench_options, @enabled,
				 @duration_secs, @no_transaction, @collect_perf, @perf_duration,
				 @perf_stat_duration, @perf_record_duration, @perf_trace_duration,
				 @perf_stat_enabled, @perf_record_enabled, @perf_trace_enabled, @perf_delay,
				 @perf_stat_delay, @perf_record_delay, @perf_trace_delay,
				 @perf_cgroup, @perf_events, @perf_repeat, @perf_freq, @perf_call_graph, @perf_mmap_pages,
				 @pg_stat_tables, @pg_stat_interval_seconds, @pg_stat_pg_locks_enabled,
				 @pg_stat_pg_locks_interval, @pg_stat_reset_stats, @pg_stat_reset_statements,
				 @pg_stat_collect_statements,
				 @proc_groups, @proc_interval_seconds
			 )
       ON CONFLICT(id) DO UPDATE SET
         position=excluded.position, name=excluded.name, type=excluded.type,
         script=excluded.script, pgbench_options=excluded.pgbench_options, enabled=excluded.enabled,
         duration_secs=excluded.duration_secs, no_transaction=excluded.no_transaction,
         collect_perf=excluded.collect_perf, perf_duration=excluded.perf_duration,
         perf_stat_duration=excluded.perf_stat_duration,
         perf_record_duration=excluded.perf_record_duration,
         perf_trace_duration=excluded.perf_trace_duration,
         perf_stat_enabled=excluded.perf_stat_enabled,
         perf_record_enabled=excluded.perf_record_enabled,
         perf_trace_enabled=excluded.perf_trace_enabled,
         perf_delay=excluded.perf_delay,
         perf_stat_delay=excluded.perf_stat_delay,
         perf_record_delay=excluded.perf_record_delay,
         perf_trace_delay=excluded.perf_trace_delay,
         perf_cgroup=excluded.perf_cgroup,
         perf_events=excluded.perf_events,
         perf_repeat=excluded.perf_repeat, perf_freq=excluded.perf_freq,
         perf_call_graph=excluded.perf_call_graph, perf_mmap_pages=excluded.perf_mmap_pages,
         pg_stat_tables=excluded.pg_stat_tables,
         pg_stat_interval_seconds=excluded.pg_stat_interval_seconds,
         pg_stat_pg_locks_enabled=excluded.pg_stat_pg_locks_enabled,
         pg_stat_pg_locks_interval=excluded.pg_stat_pg_locks_interval,
         pg_stat_reset_stats=excluded.pg_stat_reset_stats,
         pg_stat_reset_statements=excluded.pg_stat_reset_statements,
         pg_stat_collect_statements=excluded.pg_stat_collect_statements,
         proc_groups=excluded.proc_groups,
         proc_interval_seconds=excluded.proc_interval_seconds`
		);
		const submittedStepIds = body.steps
			.map((s: { id?: number }) => s.id)
			.filter((stepId: unknown): stepId is number => typeof stepId === 'number');
		const deleteRemovedSteps =
			submittedStepIds.length > 0
				? db.prepare(
						`DELETE FROM design_steps WHERE design_id = ? AND id NOT IN (${submittedStepIds.map(() => '?').join(',')})`
					)
				: db.prepare('DELETE FROM design_steps WHERE design_id = ?');

		const doUpsert = db.transaction(() => {
			deleteRemovedSteps.run(designId, ...submittedStepIds);
			for (const s of body.steps) {
				const result = upsert.run({
					...s,
					id: s.id ?? null,
					design_id: designId,
					script: s.script ?? '',
					duration_secs: s.duration_secs ?? 0,
					no_transaction: s.no_transaction ?? 0,
					collect_perf: s.collect_perf ?? 0,
					perf_duration: s.perf_duration ?? '',
					perf_stat_duration: s.perf_stat_duration ?? '',
					perf_record_duration: s.perf_record_duration ?? '',
					perf_trace_duration: s.perf_trace_duration ?? '',
					perf_stat_enabled: s.perf_stat_enabled ?? 0,
					perf_record_enabled: s.perf_record_enabled ?? 0,
					perf_trace_enabled: s.perf_trace_enabled ?? 0,
					perf_delay: s.perf_delay ?? '',
					perf_stat_delay: s.perf_stat_delay ?? '',
					perf_record_delay: s.perf_record_delay ?? '',
					perf_trace_delay: s.perf_trace_delay ?? '',
					perf_cgroup: s.perf_cgroup ?? '',
					perf_events: s.perf_events ?? '',
					perf_repeat: s.perf_repeat ?? '',
					perf_freq: s.perf_freq ?? '',
					perf_call_graph: s.perf_call_graph ?? 'dwarf',
					perf_mmap_pages: s.perf_mmap_pages ?? '',
					pg_stat_tables: s.pg_stat_tables ?? '[]',
					pg_stat_interval_seconds: s.pg_stat_interval_seconds ?? '',
					pg_stat_pg_locks_enabled: s.pg_stat_pg_locks_enabled ?? 0,
					pg_stat_pg_locks_interval: s.pg_stat_pg_locks_interval ?? '',
					pg_stat_reset_stats: s.pg_stat_reset_stats ?? 0,
					pg_stat_reset_statements: s.pg_stat_reset_statements ?? 0,
					pg_stat_collect_statements: s.pg_stat_collect_statements ?? 0,
					proc_groups: s.proc_groups ?? '[]',
					proc_interval_seconds: s.proc_interval_seconds ?? '',
				});
				const stepId = (s.id ?? result.lastInsertRowid) as number;
				deleteScripts.run(stepId);
				if (s.type === 'pgbench') {
					for (const ps of s.pgbench_scripts ?? []) {
						insertScript.run(stepId, ps.position, ps.name, ps.weight, ps.weight_expr ?? null, ps.script);
					}
				}
			}
			deleteParams.run(designId);
			for (const p of body.params ?? []) {
				insertParam.run(designId, p.position, p.name, p.value);
			}
		});
		doUpsert();
	} else {
		deleteParams.run(designId);
		for (const p of body.params ?? []) {
			insertParam.run(designId, p.position, p.name, p.value);
		}
	}

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(designId);
	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(designId) as { id: number; type: string; [key: string]: unknown }[];
	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position'
	).all(designId) as PgbenchScript[];

	const scriptsByStep = new Map<number, PgbenchScript[]>();
	for (const ps of pgbenchScripts) {
		const arr = scriptsByStep.get(ps.step_id) ?? [];
		arr.push(ps);
		scriptsByStep.set(ps.step_id, arr);
	}

	const stepsWithScripts = steps.map(s => ({
		...s,
		pgbench_scripts: s.type === 'pgbench' ? (scriptsByStep.get(s.id) ?? []) : undefined
	}));

	const designParams = db.prepare(
		'SELECT * FROM design_params WHERE design_id = ? ORDER BY position'
	).all(designId) as DesignParam[];

	return json({ ...design as object, steps: stepsWithScripts, params: designParams });
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	db.prepare('DELETE FROM designs WHERE id = ?').run(Number(params.id));
	return json({ ok: true });
};
