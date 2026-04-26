import { error } from '@sveltejs/kit';
import { connectSsh, execStreaming } from '$lib/server/ec2-runner';
import type { RequestHandler } from './$types';

const INSTALL_PG18_CMD = `
set -e
echo "==> Installing PostgreSQL 18 from pgdg apt repository..."
sudo apt-get install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \\
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
. /etc/os-release
sudo sh -c "echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt \${VERSION_CODENAME}-pgdg main' > /etc/apt/sources.list.d/pgdg.list"
echo "==> Updating apt..."
sudo apt-get update -y
echo "==> Installing postgresql-18..."
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-18
echo "==> Enabling and starting PostgreSQL service..."
sudo systemctl enable postgresql
sudo systemctl start postgresql
echo "==> Done: $(psql --version)"
`.trim();

/**
 * POST /api/onboard/install-pg
 * Installs PostgreSQL 18 on the DB droplet via SSH. Streams output as SSE.
 * Body: { host, user, private_key }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');

	const server = { id: 0, name: '', host, user: user ?? 'root', port: 22, private_key, remote_dir: '~', log_dir: '/tmp', vpc: '' };

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
				const code = await execStreaming(conn, INSTALL_PG18_CMD, (line) => send({ line }));
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
