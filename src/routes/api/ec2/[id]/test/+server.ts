import { json, error } from '@sveltejs/kit';
import { testEc2Server } from '$lib/server/services/ec2-servers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		return json(await testEc2Server({ ec2_server_id: Number(params.id) }));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw error(message.includes('not found') ? 404 : 400, message);
	}
};
