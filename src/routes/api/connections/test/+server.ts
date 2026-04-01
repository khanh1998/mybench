import { json, error } from '@sveltejs/kit';
import { testPgServer } from '$lib/server/services/pg-servers';
import type { RequestHandler } from './$types';

/**
 * POST /api/connections/test
 * Tests a PG connection using fields from the request body (no saved server ID required).
 * Used for testing before saving a new connection. Does not populate pg_stat selections
 * (that happens when testing a saved server via /api/connections/[id]/test).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	try {
		return json(await testPgServer(body));
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
};
