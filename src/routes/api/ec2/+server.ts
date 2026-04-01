import { json, error } from '@sveltejs/kit';
import { listEc2Servers, saveEc2Server } from '$lib/server/services/ec2-servers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	return json(listEc2Servers());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	try {
		return json(saveEc2Server(body).server, { status: 201 });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
};
