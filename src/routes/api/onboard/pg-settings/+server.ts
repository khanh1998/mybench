import { error, json } from '@sveltejs/kit';
import { createPool } from '$lib/server/pg-client';
import { DEFAULT_PERF_EVENTS } from '$lib/server/perf-inspect';
import type { PgServer } from '$lib/types';
import type { RequestHandler } from './$types';

/**
 * POST /api/onboard/pg-settings
 * Reads current pg_settings values for the given parameter names, over a normal
 * PG connection (not SSH) — used to show what's actually live on the server next
 * to the freeform tuning notes on a pg_servers row.
 * Body: { host, port, username, password, ssl, names: string[] }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, port, username, password, ssl, names } = body;
	if (!host) throw error(400, 'host is required');
	if (!Array.isArray(names) || names.length === 0) throw error(400, 'names is required');

	const server: PgServer = {
		id: 0, name: '', host, port: port ?? 5432, username: username ?? 'postgres', password: password ?? '',
		ssl: ssl ? 1 : 0, ssh_enabled: 0, ssh_host: null, ssh_port: 22, ssh_user: null, ssh_private_key: null,
		private_host: '', vpc: '', spec: '', pg_config: '',
		perf_enabled: 0, perf_scope: 'disabled', perf_cgroup: '', perf_events: DEFAULT_PERF_EVENTS, perf_status_json: ''
	};

	const pool = createPool(server, 'postgres');
	try {
		const result = await pool.query('SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1::text[])', [names]);
		return json({ ok: true, settings: result.rows });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	} finally {
		await pool.end();
	}
};
