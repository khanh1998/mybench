import { json, error } from '@sveltejs/kit';
import { testPgServer } from '$lib/server/services/pg-servers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json().catch(() => ({}));
	try {
		return json(await testPgServer({ server_id: Number(params.id), database: body.database }));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw error(message.includes('not found') ? 404 : 400, message);
	}
};
