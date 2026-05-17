import getDb from '$lib/server/db';
import type { PageServerLoad } from './$types';

type PgServerRow = {
	id: number;
	name: string;
	host: string;
	ssh_host: string | null;
};

type SysbenchSystemRunRow = {
	id: number;
	pg_server_id: number;
	pg_server_name: string;
	test_type: string;
	flags: string;
	output: string;
	exit_code: number;
	created_at: string;
};

export const load: PageServerLoad = () => {
	const db = getDb();
	const servers = db.prepare('SELECT * FROM pg_servers WHERE ssh_enabled = 1 ORDER BY name').all() as PgServerRow[];
	const runs = db.prepare('SELECT * FROM sysbench_system_runs ORDER BY created_at DESC LIMIT 200').all() as SysbenchSystemRunRow[];
	return { servers, runs };
};
