import { error, json } from '@sveltejs/kit';
import { connectSsh } from '$lib/server/ec2-runner';
import { detectInstanceSpec } from '$lib/server/detect-spec';
import type { RequestHandler } from './$types';

/**
 * POST /api/onboard/detect-spec
 * SSHes into a server and returns a formatted hardware spec string.
 * Body: { host, user, private_key }
 * Returns: { ok: true, spec: "4 vCPU (Intel Xeon Platinum 8168 @ 2.70GHz), 8 GB RAM, 50 GB SSD" }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');

	const server = {
		id: 0, name: '', host, user: user ?? 'root', port: 22,
		private_key, remote_dir: '~', log_dir: '/tmp', cli_log_dir: '/tmp', vpc: ''
	};

	let conn;
	try {
		conn = await connectSsh(server);
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}

	try {
		const spec = await detectInstanceSpec(conn);
		return json({ ok: true, spec });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	} finally {
		conn.end();
	}
};
