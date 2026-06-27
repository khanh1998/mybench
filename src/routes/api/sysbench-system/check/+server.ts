import { error, json } from '@sveltejs/kit';
import type { Client } from 'ssh2';
import { connectSsh, exec } from '$lib/server/ec2-runner';
import { getPgServer } from '$lib/server/services/pg-servers';
import { buildSshTarget } from '$lib/server/preset-benchmark';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const pgServerId = Number(url.searchParams.get('pg_server_id'));
	if (!Number.isInteger(pgServerId) || pgServerId <= 0) throw error(400, 'pg_server_id is required');

	const server = getPgServer(pgServerId);
	if (!server) throw error(404, `PostgreSQL connection ${pgServerId} not found`);
	const sshTarget = buildSshTarget(server);

	let conn: Client | undefined;
	try {
		conn = await connectSsh(sshTarget);
		const result = await exec(conn, 'sysbench --version 2>&1');
		const version = `${result.stdout}${result.stderr}`.trim();
		return json(result.code === 0
			? { ok: true, version }
			: { ok: false, error: version || 'sysbench not found' });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	} finally {
		conn?.end();
	}
};
