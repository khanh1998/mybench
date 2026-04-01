import getDb from '$lib/server/db';
import { testEc2Connection } from '$lib/server/ec2-runner';
import type { Ec2Server } from '$lib/types';

export interface SaveEc2ServerInput {
	ec2_server_id?: number;
	name?: string;
	host?: string;
	user?: string;
	port?: number;
	private_key?: string;
	remote_dir?: string;
	log_dir?: string;
}

export interface TestEc2ServerInput {
	ec2_server_id?: number;
	host?: string;
	user?: string;
	port?: number;
	private_key?: string;
	remote_dir?: string;
	log_dir?: string;
}

export function listEc2Servers(): Ec2Server[] {
	const db = getDb();
	return db.prepare('SELECT * FROM ec2_servers ORDER BY id').all() as Ec2Server[];
}

export function getEc2Server(ec2ServerId: number): Ec2Server | undefined {
	const db = getDb();
	return db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(ec2ServerId) as Ec2Server | undefined;
}

export function saveEc2Server(input: SaveEc2ServerInput): { action: 'created' | 'updated'; server: Ec2Server } {
	const db = getDb();
	const existing = input.ec2_server_id ? getEc2Server(input.ec2_server_id) : undefined;
	if (input.ec2_server_id && !existing) throw new Error(`EC2 server ${input.ec2_server_id} not found`);

	const next = {
		name: input.name ?? existing?.name ?? '',
		host: input.host ?? existing?.host ?? '',
		user: input.user ?? existing?.user ?? 'ec2-user',
		port: input.port ?? existing?.port ?? 22,
		private_key: input.private_key ?? existing?.private_key ?? '',
		remote_dir: input.remote_dir ?? existing?.remote_dir ?? '~/mybench-bench',
		log_dir: input.log_dir ?? existing?.log_dir ?? '/tmp/mybench-logs'
	};
	if (!next.name.trim()) throw new Error('name is required');

	if (existing) {
		db.prepare(
			'UPDATE ec2_servers SET name=?, host=?, user=?, port=?, private_key=?, remote_dir=?, log_dir=? WHERE id=?'
		).run(next.name, next.host, next.user, next.port, next.private_key, next.remote_dir, next.log_dir, input.ec2_server_id);
		return { action: 'updated', server: getEc2Server(input.ec2_server_id!)! };
	}

	const result = db.prepare(
		'INSERT INTO ec2_servers (name, host, user, port, private_key, remote_dir, log_dir) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run(next.name, next.host, next.user, next.port, next.private_key, next.remote_dir, next.log_dir);
	return { action: 'created', server: getEc2Server(result.lastInsertRowid as number)! };
}

export function deleteEc2Server(ec2ServerId: number): { deleted: true; ec2_server_id: number; name: string } {
	const db = getDb();
	const existing = db.prepare('SELECT id, name FROM ec2_servers WHERE id = ?').get(ec2ServerId) as { id: number; name: string } | undefined;
	if (!existing) throw new Error(`EC2 server ${ec2ServerId} not found`);
	db.prepare('DELETE FROM ec2_servers WHERE id = ?').run(ec2ServerId);
	return { deleted: true, ec2_server_id: ec2ServerId, name: existing.name };
}

export async function testEc2Server(input: TestEc2ServerInput): Promise<{
	ec2_server_id: number | null;
	ok: boolean;
	ssh: { ok: boolean; error?: string };
	binary?: { ok: boolean; version?: string; path?: string; error?: string };
}> {
	let target: Ec2Server | undefined;
	if (input.ec2_server_id) {
		target = getEc2Server(input.ec2_server_id);
		if (!target) throw new Error(`EC2 server ${input.ec2_server_id} not found`);
	} else {
		if (!input.host) throw new Error('host is required when ec2_server_id is omitted');
		if (!input.private_key) throw new Error('private_key is required when ec2_server_id is omitted');
		target = {
			id: 0,
			name: '',
			host: input.host,
			user: input.user ?? 'ec2-user',
			port: input.port ?? 22,
			private_key: input.private_key,
			remote_dir: input.remote_dir ?? '~/mybench-bench',
			log_dir: input.log_dir ?? '/tmp/mybench-logs'
		};
	}

	return {
		ec2_server_id: input.ec2_server_id ?? null,
		...(await testEc2Connection(target))
	};
}
