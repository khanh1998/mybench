import getDb from '$lib/server/db';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import { discoverPgStatTables, testConnection } from '$lib/server/pg-client';
import type { PgServer } from '$lib/types';

export interface SavePgServerInput {
	server_id?: number;
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	ssl?: boolean | number;
}

export interface TestPgServerInput {
	server_id?: number;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	ssl?: boolean | number;
	database?: string;
	populate_table_selections?: boolean;
}

export interface TableSelectionInput {
	table_name: string;
	enabled: boolean;
}

export function listPgServers(): PgServer[] {
	const db = getDb();
	return db.prepare('SELECT * FROM pg_servers ORDER BY id').all() as PgServer[];
}

export function getPgServer(serverId: number): PgServer | undefined {
	const db = getDb();
	return db.prepare('SELECT * FROM pg_servers WHERE id = ?').get(serverId) as PgServer | undefined;
}

export function savePgServer(input: SavePgServerInput): { action: 'created' | 'updated'; server: PgServer } {
	const db = getDb();
	const existing = input.server_id ? getPgServer(input.server_id) : undefined;
	if (input.server_id && !existing) throw new Error(`PostgreSQL connection ${input.server_id} not found`);

	const next = {
		name: input.name ?? existing?.name ?? '',
		host: input.host ?? existing?.host ?? 'localhost',
		port: input.port ?? existing?.port ?? 5432,
		username: input.username ?? existing?.username ?? 'postgres',
		password: input.password ?? existing?.password ?? '',
		ssl: input.ssl !== undefined ? (input.ssl ? 1 : 0) : (existing?.ssl ?? 0)
	};
	if (!next.name.trim()) throw new Error('name is required');

	if (existing) {
		db.prepare(
			'UPDATE pg_servers SET name=?, host=?, port=?, username=?, password=?, ssl=? WHERE id=?'
		).run(next.name, next.host, next.port, next.username, next.password, next.ssl, input.server_id);
		return { action: 'updated', server: getPgServer(input.server_id!)! };
	}

	const result = db.prepare(
		'INSERT INTO pg_servers (name, host, port, username, password, ssl) VALUES (?, ?, ?, ?, ?, ?)'
	).run(next.name, next.host, next.port, next.username, next.password, next.ssl);
	return { action: 'created', server: getPgServer(result.lastInsertRowid as number)! };
}

export function deletePgServer(serverId: number): { deleted: true; server_id: number; name: string } {
	const db = getDb();
	const existing = db.prepare('SELECT id, name FROM pg_servers WHERE id = ?').get(serverId) as { id: number; name: string } | undefined;
	if (!existing) throw new Error(`PostgreSQL connection ${serverId} not found`);
	db.prepare('DELETE FROM pg_servers WHERE id = ?').run(serverId);
	return { deleted: true, server_id: serverId, name: existing.name };
}

export async function testPgServer(input: TestPgServerInput): Promise<{
	ok: boolean;
	server_id: number | null;
	database: string;
	version?: string;
	error?: string;
	table_selection_sync?: {
		discovered_tables: string[];
		version_num: number;
		table_selections: { table_name: string; enabled: boolean }[];
	};
	table_selection_warning?: string;
}> {
	const targetDatabase = input.database ?? 'postgres';

	let target: PgServer | undefined;
	if (input.server_id) {
		target = getPgServer(input.server_id);
		if (!target) throw new Error(`PostgreSQL connection ${input.server_id} not found`);
	} else {
		if (!input.host) throw new Error('host is required when server_id is omitted');
		target = {
			id: 0,
			name: '',
			host: input.host,
			port: input.port ?? 5432,
			username: input.username ?? 'postgres',
			password: input.password ?? '',
			ssl: input.ssl ? 1 : 0
		};
	}

	const result = await testConnection(target, targetDatabase);
	if (!result.ok) {
		return {
			ok: false,
			server_id: input.server_id ?? null,
			database: targetDatabase,
			error: result.error
		};
	}

	let tableSelectionSync:
		| { discovered_tables: string[]; version_num: number; table_selections: { table_name: string; enabled: boolean }[] }
		| undefined;
	let tableSelectionWarning: string | undefined;
	if (input.server_id && input.populate_table_selections !== false) {
		try {
			tableSelectionSync = await syncPgServerTableSelections(input.server_id, targetDatabase);
		} catch (err) {
			tableSelectionWarning = err instanceof Error ? err.message : String(err);
		}
	}

	return {
		ok: true,
		server_id: input.server_id ?? null,
		database: targetDatabase,
		version: result.version,
		table_selection_sync: tableSelectionSync,
		table_selection_warning: tableSelectionWarning
	};
}

export async function syncPgServerTableSelections(serverId: number, database: string): Promise<{
	discovered_tables: string[];
	version_num: number;
	table_selections: { table_name: string; enabled: boolean }[];
}> {
	const db = getDb();
	const server = getPgServer(serverId);
	if (!server) throw new Error(`PostgreSQL connection ${serverId} not found`);

	const { tables, versionNum } = await discoverPgStatTables(server, database);
	const supportedTables = Object.keys(SNAP_TABLE_MAP);
	const insert = db.prepare(
		'INSERT OR IGNORE INTO pg_stat_table_selections (server_id, table_name, enabled) VALUES (?, ?, 1)'
	);
	const disable = db.prepare(
		'UPDATE pg_stat_table_selections SET enabled = 0 WHERE server_id = ? AND table_name = ?'
	);

	db.transaction(() => {
		for (const tableName of supportedTables) {
			insert.run(server.id, tableName);
		}
		if (versionNum < 140000) disable.run(server.id, 'pg_stat_replication_slots');
		if (versionNum < 150000) disable.run(server.id, 'pg_stat_subscription_stats');
		if (versionNum < 180000) {
			disable.run(server.id, 'pg_stat_wal');
			disable.run(server.id, 'pg_stat_io');
		}
		if (versionNum < 170000) disable.run(server.id, 'pg_stat_checkpointer');
	})();

	return {
		discovered_tables: tables,
		version_num: versionNum,
		table_selections: getPgServerTableSelections(serverId).map((row) => ({
			table_name: row.table_name,
			enabled: !!row.enabled
		}))
	};
}

export function getPgServerTableSelections(serverId: number): { table_name: string; enabled: number }[] {
	const db = getDb();
	const server = db.prepare('SELECT id FROM pg_servers WHERE id = ?').get(serverId);
	if (!server) throw new Error(`PostgreSQL connection ${serverId} not found`);

	return db
		.prepare('SELECT table_name, enabled FROM pg_stat_table_selections WHERE server_id = ? ORDER BY table_name')
		.all(serverId) as { table_name: string; enabled: number }[];
}

export function setPgServerTableSelections(serverId: number, selections: TableSelectionInput[]): {
	updated: true;
	server_id: number;
	table_selections: { table_name: string; enabled: boolean }[];
} {
	const db = getDb();
	const existing = db.prepare('SELECT id FROM pg_servers WHERE id = ?').get(serverId);
	if (!existing) throw new Error(`PostgreSQL connection ${serverId} not found`);

	const currentRows = db
		.prepare('SELECT table_name FROM pg_stat_table_selections WHERE server_id = ?')
		.all(serverId) as { table_name: string }[];
	if (currentRows.length === 0) {
		throw new Error(`No table selections exist for PostgreSQL connection ${serverId}. Run test_pg_server(server_id) first.`);
	}

	const validNames = new Set(currentRows.map((row) => row.table_name));
	const unknown = selections.map((row) => row.table_name).filter((name) => !validNames.has(name));
	if (unknown.length > 0) {
		throw new Error(`Unknown table selection(s): ${unknown.join(', ')}`);
	}

	const update = db.prepare(
		'UPDATE pg_stat_table_selections SET enabled = ? WHERE server_id = ? AND table_name = ?'
	);
	db.transaction(() => {
		for (const item of selections) {
			update.run(item.enabled ? 1 : 0, serverId, item.table_name);
		}
	})();

	return {
		updated: true,
		server_id: serverId,
		table_selections: getPgServerTableSelections(serverId).map((row) => ({
			table_name: row.table_name,
			enabled: !!row.enabled
		}))
	};
}
