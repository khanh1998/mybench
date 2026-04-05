import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { startSeries } from '$lib/server/series-executor';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const {
		design_id,
		profile_ids,
		delay_seconds,
		name,
		ec2_server_id,
		server_id,
		database,
		snapshot_interval_seconds
	} = body;

	if (!design_id || !Array.isArray(profile_ids) || profile_ids.length === 0) {
		return json({ error: 'design_id and profile_ids (non-empty array) are required' }, { status: 400 });
	}

	const seriesId = startSeries({
		design_id: Number(design_id),
		profile_ids: profile_ids.map(Number),
		delay_seconds: Number(delay_seconds ?? 0),
		name: name || undefined,
		ec2_server_id: ec2_server_id ? Number(ec2_server_id) : null,
		server_id: server_id ? Number(server_id) : undefined,
		database: database || undefined,
		snapshot_interval_seconds: snapshot_interval_seconds ? Number(snapshot_interval_seconds) : undefined
	});

	return json({ series_id: seriesId }, { status: 201 });
};
