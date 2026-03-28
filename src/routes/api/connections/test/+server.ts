import { json, error } from '@sveltejs/kit';
import { testConnection } from '$lib/server/pg-client';
import type { PgServer } from '$lib/types';
import type { RequestHandler } from './$types';

/**
 * POST /api/connections/test
 * Tests a PG connection using fields from the request body (no saved server ID required).
 * Used for testing before saving a new connection. Does not populate pg_stat selections
 * (that happens when testing a saved server via /api/connections/[id]/test).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, port, username, password, ssl, database } = body;

	if (!host) throw error(400, 'Missing host');

	const server: PgServer = {
		id: 0,
		name: '',
		host,
		port: port ?? 5432,
		username: username ?? 'postgres',
		password: password ?? '',
		ssl: ssl ? 1 : 0
	};

	const result = await testConnection(server, database ?? 'postgres');
	return json(result);
};
