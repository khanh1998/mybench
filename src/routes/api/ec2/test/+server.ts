import { json, error } from '@sveltejs/kit';
import { testEc2Connection } from '$lib/server/ec2-runner';
import type { Ec2Server } from '$lib/types';
import type { RequestHandler } from './$types';

/**
 * POST /api/ec2/test
 * Tests connection using fields from the request body (no saved server ID required).
 * Used for testing before saving, or re-testing an existing server without re-loading it.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, port, private_key, remote_dir, log_dir } = body;

	if (!host) throw error(400, 'Missing host');
	if (!private_key) throw error(400, 'Missing private_key');

	const server: Ec2Server = {
		id: 0,
		name: '',
		host,
		user: user ?? 'ec2-user',
		port: port ?? 22,
		private_key,
		remote_dir: remote_dir ?? '~/mybench-bench',
		log_dir: log_dir ?? '/tmp/mybench-logs'
	};

	const result = await testEc2Connection(server);
	return json(result);
};
