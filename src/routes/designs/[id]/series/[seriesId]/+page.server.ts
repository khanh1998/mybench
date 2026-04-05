import { error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const seriesId = Number(params.seriesId);
	const designId = Number(params.id);

	const series = db.prepare('SELECT * FROM benchmark_series WHERE id = ? AND design_id = ?').get(seriesId, designId);
	if (!series) error(404, 'Series not found');

	const design = db.prepare('SELECT id, name FROM designs WHERE id = ?').get(designId) as { id: number; name: string } | undefined;
	if (!design) error(404, 'Design not found');

	const runs = db.prepare(`
		SELECT id, status, profile_name, name, tps, latency_avg_ms, started_at, finished_at
		FROM benchmark_runs WHERE series_id = ? ORDER BY id
	`).all(seriesId);

	return { series, design, runs };
};
