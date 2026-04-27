import getDb from '$lib/server/db';
import { SNAP_TABLE_MAP } from '$lib/server/pg-stats';
import { discoverPgStatTables, testConnection } from '$lib/server/pg-client';
import { connectSsh, exec } from '$lib/server/ec2-runner';
import type { PgServer } from '$lib/types';

// Parses RDS endpoint: <instance-id>.<hash>.<region>.rds.amazonaws.com
function parseRdsHostname(host: string): { rdsInstanceId: string; awsRegion: string } {
	const match = host.match(/^([^.]+)\.[^.]+\.([\w-]+)\.rds\.amazonaws\.com$/i);
	if (match) return { rdsInstanceId: match[1], awsRegion: match[2] };
	return { rdsInstanceId: '', awsRegion: '' };
}

export interface SavePgServerInput {
	server_id?: number;
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	ssl?: boolean | number;
	rds_instance_id?: string;
	aws_region?: string;
	enhanced_monitoring?: boolean | number;
	ssh_enabled?: boolean | number;
	ssh_host?: string | null;
	ssh_port?: number;
	ssh_user?: string | null;
	ssh_private_key?: string | null;
	private_host?: string;
	vpc?: string;
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

	const newHost = input.host ?? existing?.host ?? 'localhost';
	const parsed = parseRdsHostname(newHost);
	const next = {
		name: input.name ?? existing?.name ?? '',
		host: newHost,
		port: input.port ?? existing?.port ?? 5432,
		username: input.username ?? existing?.username ?? 'postgres',
		password: input.password ?? existing?.password ?? '',
		ssl: input.ssl !== undefined ? (input.ssl ? 1 : 0) : (existing?.ssl ?? 0),
		rds_instance_id: input.rds_instance_id ?? (input.host ? parsed.rdsInstanceId : (existing?.rds_instance_id ?? '')),
		aws_region: input.aws_region ?? (input.host ? parsed.awsRegion : (existing?.aws_region ?? '')),
		enhanced_monitoring: input.enhanced_monitoring !== undefined ? (input.enhanced_monitoring ? 1 : 0) : (existing?.enhanced_monitoring ?? 0),
		ssh_enabled: input.ssh_enabled !== undefined ? (input.ssh_enabled ? 1 : 0) : (existing?.ssh_enabled ?? 0),
		ssh_host: input.ssh_host !== undefined ? (input.ssh_host || null) : (existing?.ssh_host ?? null),
		ssh_port: input.ssh_port ?? existing?.ssh_port ?? 22,
		ssh_user: input.ssh_user !== undefined ? (input.ssh_user || null) : (existing?.ssh_user ?? null),
		ssh_private_key: input.ssh_private_key !== undefined ? (input.ssh_private_key || null) : (existing?.ssh_private_key ?? null),
		private_host: input.private_host ?? existing?.private_host ?? '',
		vpc: input.vpc ?? existing?.vpc ?? ''
	};
	if (!next.name.trim()) throw new Error('name is required');

	if (existing) {
		db.prepare(
			'UPDATE pg_servers SET name=?, host=?, port=?, username=?, password=?, ssl=?, rds_instance_id=?, aws_region=?, enhanced_monitoring=?, ssh_enabled=?, ssh_host=?, ssh_port=?, ssh_user=?, ssh_private_key=?, private_host=?, vpc=? WHERE id=?'
		).run(next.name, next.host, next.port, next.username, next.password, next.ssl, next.rds_instance_id, next.aws_region, next.enhanced_monitoring, next.ssh_enabled, next.ssh_host, next.ssh_port, next.ssh_user, next.ssh_private_key, next.private_host, next.vpc, input.server_id);
		return { action: 'updated', server: getPgServer(input.server_id!)! };
	}

	const result = db.prepare(
		'INSERT INTO pg_servers (name, host, port, username, password, ssl, rds_instance_id, aws_region, enhanced_monitoring, ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_private_key, private_host, vpc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
	).run(next.name, next.host, next.port, next.username, next.password, next.ssl, next.rds_instance_id, next.aws_region, next.enhanced_monitoring, next.ssh_enabled, next.ssh_host, next.ssh_port, next.ssh_user, next.ssh_private_key, next.private_host, next.vpc);
	return { action: 'created', server: getPgServer(result.lastInsertRowid as number)! };
}

export function deletePgServer(serverId: number): { deleted: true; server_id: number; name: string } {
	const db = getDb();
	const existing = db.prepare('SELECT id, name FROM pg_servers WHERE id = ?').get(serverId) as { id: number; name: string } | undefined;
	if (!existing) throw new Error(`PostgreSQL connection ${serverId} not found`);
	db.transaction(() => {
		db.prepare('UPDATE designs SET server_id = NULL WHERE server_id = ?').run(serverId);
		db.prepare('DELETE FROM pg_servers WHERE id = ?').run(serverId);
	})();
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

	let target: PgServer;
	if (input.server_id) {
		const found = getPgServer(input.server_id);
		if (!found) throw new Error(`PostgreSQL connection ${input.server_id} not found`);
		target = found;
	} else {
		if (!input.host) throw new Error('host is required when server_id is omitted');
		target = {
			id: 0,
			name: '',
			host: input.host,
			port: input.port ?? 5432,
			username: input.username ?? 'postgres',
			password: input.password ?? '',
			ssl: input.ssl ? 1 : 0,
			rds_instance_id: '',
			aws_region: '',
			enhanced_monitoring: 0,
			ssh_enabled: 0,
			ssh_host: null,
			ssh_port: 22,
			ssh_user: null,
			ssh_private_key: null,
			private_host: '',
			vpc: ''
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

export async function testPgServerSsh(serverId: number): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
	const server = getPgServer(serverId);
	if (!server) throw new Error(`PostgreSQL connection ${serverId} not found`);
	if (!server.ssh_enabled) throw new Error('SSH is not enabled for this server');
	if (!server.ssh_user) throw new Error('SSH user is required');
	if (!server.ssh_private_key) throw new Error('SSH private key is required');

	const sshHost = server.ssh_host || server.host;

	// Build a minimal Ec2Server-compatible object
	const sshTarget = {
		id: server.id,
		name: server.name,
		host: sshHost,
		user: server.ssh_user,
		port: server.ssh_port,
		private_key: server.ssh_private_key,
		remote_dir: '',
		log_dir: '',
		vpc: ''
	};

	let conn;
	try {
		conn = await connectSsh(sshTarget);
	} catch (err: unknown) {
		return { ok: false, error: `SSH connection failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	try {
		const { stdout, code } = await exec(conn, 'which vmstat; which iostat; echo ok');
		if (code !== 0) {
			return { ok: false, error: 'Connected but could not verify vmstat/iostat availability' };
		}
		const lines = stdout.trim().split('\n').filter(Boolean);
		const tools = lines.filter((l) => l !== 'ok');
		return { ok: true, tools };
	} catch (err: unknown) {
		return { ok: false, error: `Command execution failed: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		conn.end();
	}
}
