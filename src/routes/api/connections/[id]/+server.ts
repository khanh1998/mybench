import { json, error } from '@sveltejs/kit';
import { deletePgServer, getPgServer, savePgServer } from '$lib/server/services/pg-servers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const server = getPgServer(Number(params.id));
	if (!server) throw error(404, 'Not found');
	return json(server);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await request.json();
	try {
		return json(savePgServer({ ...body, server_id: Number(params.id) }).server);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw error(message.includes('not found') ? 404 : 400, message);
	}
};

export const DELETE: RequestHandler = ({ params }) => {
	try {
		deletePgServer(Number(params.id));
		return json({ ok: true });
	} catch (err) {
		throw error(404, err instanceof Error ? err.message : String(err));
	}
};
