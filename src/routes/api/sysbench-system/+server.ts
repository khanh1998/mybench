import { error, json } from '@sveltejs/kit';
import type { Client } from 'ssh2';
import { connectSsh, exec } from '$lib/server/ec2-runner';
import getDb from '$lib/server/db';
import { getPgServer } from '$lib/server/services/pg-servers';
import { buildSshTarget } from '$lib/server/preset-benchmark';
import type { RequestHandler } from './$types';

const TEST_TYPES = new Set(['cpu', 'memory', 'fileio', 'mutex', 'threads']);

type SysbenchSystemRun = {
	id: number;
	pg_server_id: number;
	pg_server_name: string;
	test_type: string;
	flags: string;
	output: string;
	exit_code: number;
	created_at: string;
};

function combineOutput(stdout: string, stderr: string) {
	return stderr ? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}${stderr}` : stdout;
}

function buildSysbenchCommand(testType: string, flags: string, phase = 'run') {
	return ['sysbench', testType, flags, phase].filter(Boolean).join(' ');
}

async function runFileio(conn: Client, flags: string): Promise<{ output: string; exitCode: number }> {
	const tmpDir = `/tmp/sysbench-${Date.now()}`;
	const sections: string[] = [];
	let exitCode = 0;

	await exec(conn, `mkdir -p ${tmpDir}`);
	try {
		for (const phase of ['prepare', 'run', 'cleanup']) {
			const command = buildSysbenchCommand('fileio', flags, phase);
			const result = await exec(conn, `cd ${tmpDir} && ${command}`);
			if (result.code !== 0 && exitCode === 0) exitCode = result.code;
			sections.push(`=== ${phase.toUpperCase()} ===\n$ ${command}\n${combineOutput(result.stdout, result.stderr).trimEnd()}`);
		}
	} finally {
		await exec(conn, `rm -rf ${tmpDir}`);
	}

	return { output: sections.join('\n\n'), exitCode };
}

export const GET: RequestHandler = () => {
	const db = getDb();
	const runs = db.prepare('SELECT * FROM sysbench_system_runs ORDER BY created_at DESC').all();
	return json(runs);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const pgServerId = Number(body.pg_server_id);
	const testType = String(body.test_type ?? '');
	const flags = String(body.flags ?? '').trim();

	if (!Number.isInteger(pgServerId) || pgServerId <= 0) throw error(400, 'pg_server_id is required');
	if (!TEST_TYPES.has(testType)) throw error(400, 'test_type must be cpu, memory, fileio, mutex, or threads');

	const server = getPgServer(pgServerId);
	if (!server) throw error(404, `PostgreSQL connection ${pgServerId} not found`);
	const sshTarget = buildSshTarget(server);

	let conn: Client | undefined;
	try {
		conn = await connectSsh(sshTarget);

		const result = testType === 'fileio'
			? await runFileio(conn, flags)
			: await (async () => {
				const commandResult = await exec(conn!, buildSysbenchCommand(testType, flags));
				return {
					output: combineOutput(commandResult.stdout, commandResult.stderr).trimEnd(),
					exitCode: commandResult.code
				};
			})();
		const output = testType === 'fileio'
			? result.output
			: `$ ${buildSysbenchCommand(testType, flags)}\n${result.output}`;

		const db = getDb();
		const insert = db.prepare(`
			INSERT INTO sysbench_system_runs (pg_server_id, pg_server_name, test_type, flags, output, exit_code)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
		const row = insert.run(server.id, server.name, testType, flags, output, result.exitCode);
		const inserted = db
			.prepare('SELECT * FROM sysbench_system_runs WHERE id = ?')
			.get(row.lastInsertRowid) as SysbenchSystemRun;

		return json(inserted, { status: 201 });
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : String(err));
	} finally {
		conn?.end();
	}
};
