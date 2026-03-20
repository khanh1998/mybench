import pg from 'pg';
import type { PgServer } from '$lib/types';

function sslConfig(server: PgServer) {
	return server.ssl ? { rejectUnauthorized: false } : false;
}

const pools = new Map<number, pg.Pool>();

export function getPool(server: PgServer, database: string): pg.Pool {
	const key = server.id;
	// For runs we want per-database pools; use a composite key
	const compositeKey = `${server.id}:${database}`;
	const cached = pools.get(parseInt(compositeKey) || key);

	// Simple: create fresh pool each time for runs, reuse for same server+db
	return new pg.Pool({
		host: server.host,
		port: server.port,
		user: server.username,
		password: server.password,
		database,
		ssl: sslConfig(server),
		max: 5,
		connectionTimeoutMillis: 10000
	});
}

export function createPool(server: PgServer, database: string): pg.Pool {
	return new pg.Pool({
		host: server.host,
		port: server.port,
		user: server.username,
		password: server.password,
		database,
		ssl: sslConfig(server),
		max: 5,
		connectionTimeoutMillis: 10000
	});
}

export async function testConnection(server: PgServer, database: string = 'postgres'): Promise<{ ok: boolean; version?: string; error?: string }> {
	const pool = new pg.Pool({
		host: server.host,
		port: server.port,
		user: server.username,
		password: server.password,
		database,
		ssl: sslConfig(server),
		max: 1,
		connectionTimeoutMillis: 5000
	});
	try {
		const result = await pool.query('SELECT version()');
		return { ok: true, version: result.rows[0].version };
	} catch (err: unknown) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		await pool.end();
	}
}

export async function discoverPgStatTables(server: PgServer, database: string = 'postgres'): Promise<{ tables: string[]; versionNum: number }> {
	const pool = new pg.Pool({
		host: server.host,
		port: server.port,
		user: server.username,
		password: server.password,
		database,
		ssl: sslConfig(server),
		max: 1,
		connectionTimeoutMillis: 5000
	});
	try {
		const verResult = await pool.query(`SELECT current_setting('server_version_num')::int AS ver`);
		const versionNum: number = verResult.rows[0].ver;

		const result = await pool.query(`
      SELECT viewname FROM pg_catalog.pg_views
      WHERE schemaname = 'pg_catalog' AND viewname LIKE 'pg_stat%'
      ORDER BY viewname
    `);
		const tables: string[] = result.rows.map((r: { viewname: string }) => r.viewname);
		return { tables, versionNum };
	} finally {
		await pool.end();
	}
}
