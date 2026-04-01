import { json, error } from '@sveltejs/kit';
import { deleteEc2Server, getEc2Server, saveEc2Server } from '$lib/server/services/ec2-servers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const server = getEc2Server(Number(params.id));
	if (!server) throw error(404, 'Not found');
	return json(server);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await request.json();
	try {
		return json(saveEc2Server({ ...body, ec2_server_id: Number(params.id) }).server);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw error(message.includes('not found') ? 404 : 400, message);
	}
};

export const DELETE: RequestHandler = ({ params }) => {
	try {
		deleteEc2Server(Number(params.id));
		return json({ ok: true });
	} catch (err) {
		throw error(404, err instanceof Error ? err.message : String(err));
	}
};
