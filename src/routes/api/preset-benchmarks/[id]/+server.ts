import { error, json } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { SystemBenchmark, SystemBenchmarkResult } from '$lib/server/preset-benchmark';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const id = Number(params.id);
	const db = getDb();

	const benchmark = db.prepare('SELECT * FROM system_benchmarks WHERE id = ?').get(id) as SystemBenchmark | undefined;
	if (!benchmark) throw error(404, 'Benchmark not found');

	const results = db.prepare('SELECT * FROM system_benchmark_results WHERE benchmark_id = ? ORDER BY id').all(id) as SystemBenchmarkResult[];

	return json({ benchmark, results });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	const db = getDb();

	const benchmark = db.prepare('SELECT id FROM system_benchmarks WHERE id = ?').get(id);
	if (!benchmark) throw error(404, 'Benchmark not found');

	const body = await request.json();
	if (typeof body.pg_server_name === 'string') {
		const name = body.pg_server_name.trim();
		if (!name) throw error(400, 'Name cannot be empty');
		db.prepare('UPDATE system_benchmarks SET pg_server_name = ? WHERE id = ?').run(name, id);
	}

	const updated = db.prepare('SELECT * FROM system_benchmarks WHERE id = ?').get(id) as SystemBenchmark;
	return json(updated);
};

export const DELETE: RequestHandler = ({ params }) => {
	const id = Number(params.id);
	const db = getDb();

	const benchmark = db.prepare('SELECT id FROM system_benchmarks WHERE id = ?').get(id);
	if (!benchmark) throw error(404, 'Benchmark not found');

	db.prepare('DELETE FROM system_benchmarks WHERE id = ?').run(id);
	return json({ ok: true });
};
