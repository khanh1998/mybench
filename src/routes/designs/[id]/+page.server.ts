import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';
import type { PgbenchScript, DesignParam } from '$lib/types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const id = Number(params.id);

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(id);
	if (!design) return { design: null, servers: [], runs: [] };

	const steps = db.prepare('SELECT * FROM design_steps WHERE design_id = ? ORDER BY position').all(id) as { id: number; type: string; [key: string]: unknown }[];
	const pgbenchScripts = db.prepare(
		'SELECT * FROM pgbench_scripts WHERE step_id IN (SELECT id FROM design_steps WHERE design_id = ?) ORDER BY step_id, position'
	).all(id) as PgbenchScript[];

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
	).all(id) as DesignParam[];

	const servers = db.prepare('SELECT id, name, host, port, username, password, ssl FROM pg_servers ORDER BY id').all();
	const runs = db.prepare('SELECT * FROM benchmark_runs WHERE design_id = ? ORDER BY id DESC').all(id);

	return {
		design: { ...design as object, steps: stepsWithScripts, params: designParams },
		servers,
		runs
	};
};
