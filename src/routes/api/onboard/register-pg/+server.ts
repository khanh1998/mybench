import { error, json } from '@sveltejs/kit';
import { savePgServer, testPgServer } from '$lib/server/services/pg-servers';
import { DEFAULT_PERF_EVENTS } from '$lib/server/perf-inspect';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { cluster_name, db, pg_config, perf } = body;
	if (!cluster_name?.trim()) throw error(400, 'cluster_name is required');
	if (!db?.public_host || !db?.private_ip || !db?.private_key) throw error(400, 'db host, private_ip, and private_key are required');
	if (!pg_config?.db_pass) throw error(400, 'pg_config.db_pass is required');

	const dbUser = pg_config.db_user ?? 'mybench';
	const dbName = pg_config.db_name ?? 'mybench';

	const { server: pgServer } = savePgServer({
		name: `${cluster_name} — PostgreSQL`,
		host: db.public_host,
		port: 5432,
		username: dbUser,
		password: pg_config.db_pass,
		ssl: false,
		ssh_enabled: true,
		ssh_host: db.public_host,
		ssh_port: 22,
		ssh_user: db.user ?? 'root',
		ssh_private_key: db.private_key,
		private_host: db.private_ip,
		vpc: db.vpc ?? '',
		spec: db.spec ?? '',
		pg_config: db.pg_config ?? '',
		perf_enabled: perf?.scope === 'postgres_cgroup' || perf?.scope === 'system',
		perf_scope: perf?.scope ?? 'disabled',
		perf_cgroup: perf?.perf_cgroup ?? '',
		perf_events: perf?.perf_events ?? DEFAULT_PERF_EVENTS,
		perf_status_json: perf ? JSON.stringify(perf) : ''
	});

	const pgTest = await testPgServer({ server_id: pgServer.id, database: dbName })
		.catch((err) => ({ ok: false, error: String(err) }));

	return json({
		ok: pgTest.ok,
		pg_server_id: pgServer.id,
		pg_test: pgTest
	});
};
