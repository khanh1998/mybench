import { error } from '@sveltejs/kit';
import { connectSsh, execStreaming } from '$lib/server/ec2-runner';
import type { RequestHandler } from './$types';

/**
 * POST /api/onboard/install-perf
 * Installs linux-tools-common (perf) on the DB droplet. Streams output as SSE.
 * Body: { host, user, private_key }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');

	const server = { id: 0, name: '', host, user: user ?? 'root', port: 22, private_key, remote_dir: '~', log_dir: '/tmp', vpc: '' };

	const cmd = `
set -e
export DEBIAN_FRONTEND=noninteractive
echo "==> Installing perf (linux-tools)..."
sudo apt-get update -qq
sudo apt-get install -y linux-tools-common linux-tools-generic linux-tools-$(uname -r) 2>/dev/null || \
  sudo apt-get install -y linux-tools-common linux-tools-generic
perf --version
echo "perf installed successfully."
`.trim();

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			const send = (data: object) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

			let conn;
			try {
				conn = await connectSsh(server);
			} catch (err) {
				send({ done: true, ok: false, error: err instanceof Error ? err.message : String(err) });
				controller.close();
				return;
			}

			try {
				const code = await execStreaming(conn, cmd, (line) => send({ line }));
				send({ done: true, ok: code === 0 });
			} catch (err) {
				send({ done: true, ok: false, error: err instanceof Error ? err.message : String(err) });
			} finally {
				conn.end();
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }
	});
};
