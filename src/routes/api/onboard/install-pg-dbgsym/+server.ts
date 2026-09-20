import { error } from '@sveltejs/kit';
import { connectSsh, execStreaming } from '$lib/server/ec2-runner';
import type { RequestHandler } from './$types';

const INSTALL_PG_DBGSYM_CMD = `
set -e
export DEBIAN_FRONTEND=noninteractive
echo "==> Installing postgresql-18-dbgsym (debug symbols for perf c2c symbol resolution)..."
sudo apt-get install -y postgresql-18-dbgsym
PG_BIN=$(pg_config --bindir 2>/dev/null)/postgres
# Use "file" rather than "readelf" — binutils (which provides readelf) is not
# installed by default on Ubuntu 24.04, while "file" is part of the base image.
BUILD_ID=$(file "$PG_BIN" 2>/dev/null | sed -n 's/.*BuildID\\[sha1\\]=\\([0-9a-f]*\\).*/\\1/p')
if [ -n "$BUILD_ID" ]; then
  BUILD_ID_PREFIX=$(printf '%s' "$BUILD_ID" | cut -c1-2)
  BUILD_ID_REST=$(printf '%s' "$BUILD_ID" | cut -c3-)
  DEBUG_FILE="/usr/lib/debug/.build-id/$BUILD_ID_PREFIX/$BUILD_ID_REST.debug"
  if [ -f "$DEBUG_FILE" ]; then
    echo "==> Debug symbols verified at: $DEBUG_FILE"
  else
    echo "Warning: package installed but debug file not found at expected path ($DEBUG_FILE). This usually means the installed postgresql-18-dbgsym build-id doesn't match the running postgres binary (e.g. apt updated between installs) — try re-running install after an 'apt-get update && apt-get install --reinstall postgresql-18 postgresql-18-dbgsym'."
  fi
fi
echo "==> Done."
`.trim();

/**
 * POST /api/onboard/install-pg-dbgsym
 * Installs postgresql-18-dbgsym on the DB server via SSH.
 * Required for perf c2c symbol resolution (resolves raw Postgres addresses to function names).
 * Streams output as SSE.
 * Body: { host, user, private_key }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');

	const server = { id: 0, name: '', host, user: user ?? 'root', port: 22, private_key, remote_dir: '~', log_dir: '/tmp', cli_log_dir: '/tmp/gocli-logs', vpc: '' };

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
				const code = await execStreaming(conn, INSTALL_PG_DBGSYM_CMD, (line) => send({ line }));
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
