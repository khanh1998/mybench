import { json, error } from '@sveltejs/kit';
import { testEc2Server } from '$lib/server/services/ec2-servers';
import type { RequestHandler } from './$types';

/**
 * POST /api/ec2/test
 * Tests connection using fields from the request body (no saved server ID required).
 * Used for testing before saving, or re-testing an existing server without re-loading it.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	try {
		return json(await testEc2Server(body));
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
};
