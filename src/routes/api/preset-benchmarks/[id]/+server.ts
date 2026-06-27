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

export const DELETE: RequestHandler = ({ params }) => {
	const id = Number(params.id);
	const db = getDb();

	const benchmark = db.prepare('SELECT id FROM system_benchmarks WHERE id = ?').get(id);
	if (!benchmark) throw error(404, 'Benchmark not found');

	db.prepare('DELETE FROM system_benchmarks WHERE id = ?').run(id);
	return json({ ok: true });
};
