import getDb from '$lib/server/db';
import { testConnection } from '$lib/server/pg-client';
import { connectSsh, exec } from '$lib/server/ec2-runner';
import { DEFAULT_PERF_EVENTS } from '$lib/server/perf-inspect';
import type { PgServer } from '$lib/types';

export interface SavePgServerInput {
	server_id?: number;
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	ssl?: boolean | number;
	ssh_enabled?: boolean | number;
	ssh_host?: string | null;
	ssh_port?: number;
	ssh_user?: string | null;
	ssh_private_key?: string | null;
	private_host?: string;
	vpc?: string;
	spec?: string;
	pg_config?: string;
	perf_enabled?: boolean | number;
	perf_scope?: 'postgres_cgroup' | 'system' | 'disabled';
	perf_cgroup?: string;
	perf_events?: string;
	perf_status_json?: string;
}

export interface TestPgServerInput {
	server_id?: number;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	ssl?: boolean | number;
	database?: string;
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
	const next = {
		name: input.name ?? existing?.name ?? '',
		host: newHost,
		port: input.port ?? existing?.port ?? 5432,
		username: input.username ?? existing?.username ?? 'postgres',
		password: input.password ?? existing?.password ?? '',
		ssl: input.ssl !== undefined ? (input.ssl ? 1 : 0) : (existing?.ssl ?? 0),
		ssh_enabled: input.ssh_enabled !== undefined ? (input.ssh_enabled ? 1 : 0) : (existing?.ssh_enabled ?? 0),
		ssh_host: input.ssh_host !== undefined ? (input.ssh_host || null) : (existing?.ssh_host ?? null),
		ssh_port: input.ssh_port ?? existing?.ssh_port ?? 22,
		ssh_user: input.ssh_user !== undefined ? (input.ssh_user || null) : (existing?.ssh_user ?? null),
		ssh_private_key: input.ssh_private_key !== undefined ? (input.ssh_private_key || null) : (existing?.ssh_private_key ?? null),
		private_host: input.private_host ?? existing?.private_host ?? '',
		vpc: input.vpc ?? existing?.vpc ?? '',
		spec: input.spec ?? existing?.spec ?? '',
		pg_config: input.pg_config ?? existing?.pg_config ?? '',
		perf_enabled: input.perf_enabled !== undefined ? (input.perf_enabled ? 1 : 0) : (existing?.perf_enabled ?? 0),
		perf_scope: input.perf_scope ?? existing?.perf_scope ?? 'disabled',
		perf_cgroup: input.perf_cgroup ?? existing?.perf_cgroup ?? '',
		perf_events: input.perf_events ?? existing?.perf_events ?? DEFAULT_PERF_EVENTS,
		perf_status_json: input.perf_status_json ?? existing?.perf_status_json ?? ''
	};
	if (!next.name.trim()) throw new Error('name is required');

	if (existing) {
		db.prepare(
			'UPDATE pg_servers SET name=?, host=?, port=?, username=?, password=?, ssl=?, ssh_enabled=?, ssh_host=?, ssh_port=?, ssh_user=?, ssh_private_key=?, private_host=?, vpc=?, spec=?, pg_config=?, perf_enabled=?, perf_scope=?, perf_cgroup=?, perf_events=?, perf_status_json=? WHERE id=?'
		).run(next.name, next.host, next.port, next.username, next.password, next.ssl, next.ssh_enabled, next.ssh_host, next.ssh_port, next.ssh_user, next.ssh_private_key, next.private_host, next.vpc, next.spec, next.pg_config, next.perf_enabled, next.perf_scope, next.perf_cgroup, next.perf_events, next.perf_status_json, input.server_id);
		return { action: 'updated', server: getPgServer(input.server_id!)! };
	}

	const result = db.prepare(
		'INSERT INTO pg_servers (name, host, port, username, password, ssl, ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_private_key, private_host, vpc, spec, pg_config, perf_enabled, perf_scope, perf_cgroup, perf_events, perf_status_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
	).run(next.name, next.host, next.port, next.username, next.password, next.ssl, next.ssh_enabled, next.ssh_host, next.ssh_port, next.ssh_user, next.ssh_private_key, next.private_host, next.vpc, next.spec, next.pg_config, next.perf_enabled, next.perf_scope, next.perf_cgroup, next.perf_events, next.perf_status_json);
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
			ssh_enabled: 0,
			ssh_host: null,
			ssh_port: 22,
			ssh_user: null,
			ssh_private_key: null,
			private_host: '',
			vpc: '',
			perf_enabled: 0,
			perf_scope: 'disabled',
			perf_cgroup: '',
			perf_events: DEFAULT_PERF_EVENTS,
			perf_status_json: ''
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

	return {
		ok: true,
		server_id: input.server_id ?? null,
		database: targetDatabase,
		version: result.version
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
		cli_log_dir: '/tmp/gocli-logs',
		vpc: ''
	};

	let conn;
	try {
		conn = await connectSsh(sshTarget);
	} catch (err: unknown) {
		return { ok: false, error: `SSH connection failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	try {
		const { stdout, code } = await exec(conn, 'which iostat; echo ok');
		if (code !== 0) {
			return { ok: false, error: 'Connected but could not verify iostat availability' };
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
