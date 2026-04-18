import { json, error } from '@sveltejs/kit';
import { testPgServerSsh } from '$lib/server/services/pg-servers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params }) => {
	try {
		return json(await testPgServerSsh(Number(params.id)));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw error(message.includes('not found') ? 404 : 400, message);
	}
};
