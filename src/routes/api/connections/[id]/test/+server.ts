import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { testConnection, discoverPgStatTables } from '$lib/server/pg-client';
import type { PgServer } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const server = db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(Number(params.id)) as PgServer | undefined;
	if (!server) throw error(404, 'Server not found');

	const body = await request.json().catch(() => ({}));
	const database = body.database ?? 'postgres';

	const result = await testConnection(server, database);
	if (!result.ok) {
		return json({ ok: false, error: result.error });
	}

	// Discover and populate pg_stat table selections
	try {
		const { tables, versionNum } = await discoverPgStatTables(server, database);

		// Determine which snap tables we support
		const { SNAP_TABLE_MAP } = await import('$lib/server/pg-stats');
		const supportedTables = Object.keys(SNAP_TABLE_MAP);

		// Filter to only tables we have snap_ equivalents for
		const ourTables = tables.filter((t) => supportedTables.includes(t));

		// Also add statio tables (they show up as views but may have prefix pg_statio_)
		const allTables = [...new Set([...ourTables, ...supportedTables.filter(t => tables.includes(t))])];

		const insert = db.prepare(
			'INSERT OR IGNORE INTO pg_stat_table_selections (server_id, table_name, enabled) VALUES (?, ?, 1)'
		);
		const disable = db.prepare(
			'UPDATE pg_stat_table_selections SET enabled = 0 WHERE server_id = ? AND table_name = ?'
		);

		const doInsert = db.transaction(() => {
			for (const t of supportedTables) {
				insert.run(server.id, t);
			}
			// Disable version-incompatible tables
			if (versionNum < 140000) {
				disable.run(server.id, 'pg_stat_replication_slots');
			}
			if (versionNum < 150000) {
				disable.run(server.id, 'pg_stat_subscription_stats');
			}
			if (versionNum < 180000) {
				disable.run(server.id, 'pg_stat_wal');
				disable.run(server.id, 'pg_stat_io');
			}
			if (versionNum < 170000) {
				disable.run(server.id, 'pg_stat_checkpointer');
			}
		});
		doInsert();
	} catch (_err) {
		// Non-fatal
	}

	return json({ ok: true, version: result.version });
};
