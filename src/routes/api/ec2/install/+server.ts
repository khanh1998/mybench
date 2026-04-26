import { error } from '@sveltejs/kit';
import { connectSsh, execStreaming, buildInstallCommand, shellQuote } from '$lib/server/ec2-runner';
import type { RequestHandler } from './$types';

/**
 * POST /api/ec2/install
 * Installs a tool on a remote server via SSH. Streams output as SSE.
 * Body: { host, user, port, private_key, remote_dir, log_dir, tool: 'mybench-runner' | 'pgbench' | 'sysbench' }
 * Events: { line: string } for output, { done: true, ok: boolean, error?: string } when finished.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { tool, host, user, port, private_key, remote_dir, log_dir } = body;

	if (!tool || !['mybench-runner', 'pgbench', 'sysbench'].includes(tool)) {
		throw error(400, 'tool must be one of: mybench-runner, pgbench, sysbench');
	}
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');

	const server = {
		id: 0, name: '', host, user: user ?? 'ec2-user',
		port: port ?? 22, private_key,
		remote_dir: remote_dir ?? '~/mybench-bench',
		log_dir: log_dir ?? '/tmp/mybench-logs',
		vpc: ''
	};

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			const send = (data: object) => {
				controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
			};

			let conn;
			try {
				conn = await connectSsh(server);
			} catch (err) {
				send({ done: true, ok: false, error: err instanceof Error ? err.message : String(err) });
				controller.close();
				return;
			}

			try {
				// Expand ~ in remote_dir so install command has absolute path
				const homeRes = await new Promise<string>((resolve) => {
					conn!.exec('echo $HOME', (e, stream) => {
						if (e) { resolve('~'); return; }
						let out = '';
						stream.on('data', (d: Buffer) => { out += d.toString(); });
						stream.on('close', () => resolve(out.trim()));
					});
				});
				const expandedDir = server.remote_dir.replace(/^~/, homeRes);
				const cmd = buildInstallCommand(tool as 'mybench-runner' | 'pgbench' | 'sysbench', expandedDir);

				const code = await execStreaming(conn, cmd, (line) => send({ line }));
				send({ done: true, ok: code === 0 });
			} catch (err) {
				send({ done: true, ok: false, error: err instanceof Error ? err.message : String(err) });
			} finally {
				conn?.end();
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'X-Accel-Buffering': 'no'
		}
	});
};
