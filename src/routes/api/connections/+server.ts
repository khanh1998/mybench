import { json, error } from '@sveltejs/kit';
import { listPgServers, savePgServer } from '$lib/server/services/pg-servers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	return json(listPgServers());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	try {
		return json(savePgServer(body).server, { status: 201 });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
};
