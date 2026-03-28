import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { testEc2Connection } from '$lib/server/ec2-runner';
import type { Ec2Server } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	const db = getDb();
	const server = db
		.prepare('SELECT * FROM ec2_servers WHERE id = ?')
		.get(Number(params.id)) as Ec2Server | undefined;
	if (!server) throw error(404, 'EC2 server not found');
	const result = await testEc2Connection(server);
	return json(result);
};
