import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { startRun } from '$lib/server/run-executor';
import { startEc2Run } from '$lib/server/ec2-executor';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const db = getDb();
	const designId = url.searchParams.get('design_id');
	const runs = designId
		? db.prepare('SELECT * FROM benchmark_runs WHERE design_id = ? ORDER BY id DESC').all(Number(designId))
		: db.prepare('SELECT * FROM benchmark_runs ORDER BY id DESC LIMIT 50').all();
	return json(runs);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { design_id, server_id, database, snapshot_interval_seconds, profile_id, name, ec2_server_id, use_private_ip } = body;
	if (!design_id) throw error(400, 'Missing design_id');
	try {
		if (ec2_server_id) {
			const runId = startEc2Run(Number(design_id), Number(ec2_server_id), {
				server_id,
				database,
				profile_id,
				name,
				snapshot_interval_seconds,
				use_private_ip: !!use_private_ip
			});
			return json({ run_id: runId }, { status: 201 });
		} else {
			const runId = startRun(Number(design_id), { server_id, database, snapshot_interval_seconds, profile_id, name, use_private_ip: !!use_private_ip });
			return json({ run_id: runId }, { status: 201 });
		}
	} catch (e: unknown) {
		throw error(400, e instanceof Error ? e.message : String(e));
	}
};
