import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { connectSsh, exec, shellQuote } from '$lib/server/ec2-runner';
import { getEc2Server } from '$lib/server/services/ec2-servers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const db = getDb();
	const run = db.prepare('SELECT id, status, ec2_server_id, ec2_run_token FROM benchmark_runs WHERE id = ?').get(Number(params.id)) as {
		id: number;
		status: string;
		ec2_server_id: number | null;
		ec2_run_token: string | null;
	} | undefined;

	if (!run) throw error(404, 'Not found');
	if (!run.ec2_server_id || !run.ec2_run_token) throw error(400, 'Not an EC2 run');

	const ec2Server = getEc2Server(run.ec2_server_id);
	if (!ec2Server) throw error(404, 'EC2 server not found');

	const conn = await connectSsh(ec2Server).catch((err) => {
		throw error(502, `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`);
	});

	try {
		const homeDir = (await exec(conn, 'echo $HOME')).stdout.trim();
		const remoteDir = ec2Server.remote_dir.replace(/^~/, homeDir);
		const remoteLogDir = ec2Server.log_dir.replace(/^~/, homeDir);
		const remoteResultPath = `${remoteDir}/result-${run.ec2_run_token}.json`;

		// Check if mybench-runner process is alive; match ec2_run_token in command args for precision
		const pgrepResult = await exec(conn, `pgrep -la mybench-runner 2>/dev/null || true`);
		const pgrepLines = pgrepResult.stdout.trim().split('\n').filter(Boolean);
		const matchingLine = pgrepLines.find((line) => line.includes(run.ec2_run_token!));
		const alive = !!matchingLine;
		const pid = alive ? Number(matchingLine!.split(/\s+/)[0]) || undefined : undefined;

		// Check if result file exists
		const resultCheck = await exec(conn, `test -f ${shellQuote(remoteResultPath)} && echo exists || true`);
		const result_exists = resultCheck.stdout.trim() === 'exists';

		// List log files
		const lsResult = await exec(conn, `ls -1 ${shellQuote(remoteLogDir)} 2>/dev/null || true`);
		const log_files = lsResult.stdout.trim().split('\n').filter(Boolean);

		return json({ alive, pid, result_exists, log_files });
	} finally {
		conn.end();
	}
};
