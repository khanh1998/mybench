import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { connectSsh, exec, shellQuote } from '$lib/server/ec2-runner';
import { getEc2Server } from '$lib/server/services/ec2-servers';
import type { RequestHandler } from './$types';

const LOG_CAP = 500_000;

export const GET: RequestHandler = async ({ params, url }) => {
	const db = getDb();
	const run = db.prepare('SELECT id, ec2_server_id, ec2_run_token FROM benchmark_runs WHERE id = ?').get(Number(params.id)) as {
		id: number;
		ec2_server_id: number | null;
		ec2_run_token: string | null;
	} | undefined;

	if (!run) throw error(404, 'Not found');
	if (!run.ec2_server_id) throw error(400, 'Not an EC2 run');

	const ec2Server = getEc2Server(run.ec2_server_id);
	if (!ec2Server) throw error(404, 'EC2 server not found');

	const file = url.searchParams.get('file');

	// Validate filename — no path traversal
	if (file !== null && (file.includes('/') || file.includes('..') || file === '')) {
		throw error(400, 'Invalid filename');
	}

	const conn = await connectSsh(ec2Server).catch((err) => {
		throw error(502, `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`);
	});

	try {
		const homeDir = (await exec(conn, 'echo $HOME')).stdout.trim();
		const remoteLogDir = ec2Server.log_dir.replace(/^~/, homeDir);

		if (!file) {
			// List files
			const lsResult = await exec(conn, `ls -1 ${shellQuote(remoteLogDir)} 2>/dev/null || true`);
			const files = lsResult.stdout.trim().split('\n').filter(Boolean);
			return json({ files });
		}

		// Read a specific file
		const filePath = `${remoteLogDir}/${file}`;
		const catResult = await exec(conn, `cat ${shellQuote(filePath)} 2>/dev/null`);

		if (catResult.code !== 0 && catResult.stdout === '' && catResult.stderr !== '') {
			throw error(404, 'File not found');
		}

		let content = catResult.stdout;
		if (content.length > LOG_CAP) {
			content = content.slice(0, LOG_CAP) + '\n[truncated]';
		}

		return json({ filename: file, content });
	} finally {
		conn.end();
	}
};
