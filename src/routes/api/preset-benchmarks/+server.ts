import { error, json } from '@sveltejs/kit';
import { getPgServer } from '$lib/server/services/pg-servers';
import { startPresetBenchmark, type PresetProfile } from '$lib/server/preset-benchmark';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

const VALID_PRESETS = new Set<PresetProfile>(['quick', 'standard', 'deep']);

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const pgServerId = Number(body.pg_server_id);
	const preset = String(body.preset ?? 'standard') as PresetProfile;

	if (!Number.isInteger(pgServerId) || pgServerId <= 0) throw error(400, 'pg_server_id is required');
	if (!VALID_PRESETS.has(preset)) throw error(400, 'preset must be quick, standard, or deep');

	const server = getPgServer(pgServerId);
	if (!server) throw error(404, `PostgreSQL server ${pgServerId} not found`);
	if (!server.ssh_enabled) throw error(400, 'SSH is not enabled for this server');

	const { id } = startPresetBenchmark(pgServerId, preset);
	return json({ id }, { status: 201 });
};

export const GET: RequestHandler = () => {
	const db = getDb();
	const benchmarks = db.prepare('SELECT * FROM system_benchmarks ORDER BY created_at DESC LIMIT 50').all();
	return json(benchmarks);
};
