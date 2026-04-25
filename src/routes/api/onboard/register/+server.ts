import { error, json } from '@sveltejs/kit';
import { savePgServer, testPgServer } from '$lib/server/services/pg-servers';
import { saveEc2Server, testEc2Server } from '$lib/server/services/ec2-servers';
import type { RequestHandler } from './$types';

/**
 * POST /api/onboard/register
 * Saves both droplets to mybench (pg_servers + ec2_servers) and runs a test on each.
 * Body: {
 *   cluster_name,
 *   client: { host, user, private_key },
 *   db: { public_host, private_ip, user, private_key },
 *   pg_config: { db_user, db_pass, db_name }
 * }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { cluster_name, client, db, pg_config } = body;
	if (!cluster_name?.trim()) throw error(400, 'cluster_name is required');
	if (!client?.host || !client?.private_key) throw error(400, 'client host and private_key are required');
	if (!db?.public_host || !db?.private_ip || !db?.private_key) throw error(400, 'db host, private_ip, and private_key are required');
	if (!pg_config?.db_pass) throw error(400, 'pg_config.db_pass is required');

	const dbUser = pg_config.db_user ?? 'mybench';
	const dbName = pg_config.db_name ?? 'mybench';

	// Save EC2 (client droplet) — SSH via public IP
	const { server: ec2Server } = saveEc2Server({
		name: `${cluster_name} — Client`,
		host: client.host,
		user: client.user ?? 'root',
		port: 22,
		private_key: client.private_key,
		remote_dir: '~/mybench-bench',
		log_dir: '/tmp/mybench-logs'
	});

	// Save PG server — connect via public IP (mybench runs locally, can't reach private VPC)
	// SSH fields used for OS metrics collection only
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
		ssh_private_key: db.private_key
	});

	// Test both
	const [ec2Test, pgTest] = await Promise.allSettled([
		testEc2Server({ ec2_server_id: ec2Server.id }),
		testPgServer({ server_id: pgServer.id, database: dbName, populate_table_selections: true })
	]);

	const ec2Result = ec2Test.status === 'fulfilled' ? ec2Test.value : { ok: false, error: String(ec2Test.reason) };
	const pgResult = pgTest.status === 'fulfilled' ? pgTest.value : { ok: false, error: String(pgTest.reason) };

	return json({
		ok: ec2Result.ok && pgResult.ok,
		pg_server_id: pgServer.id,
		ec2_server_id: ec2Server.id,
		pg_test: pgResult,
		ec2_test: ec2Result
	});
};
