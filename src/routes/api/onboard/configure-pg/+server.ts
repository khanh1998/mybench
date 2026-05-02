import { error } from '@sveltejs/kit';
import { connectSsh, execStreaming } from '$lib/server/ec2-runner';
import type { RequestHandler } from './$types';

function buildConfigureCmd(
	dbPrivateIp: string,
	clientPrivateIp: string,
	dbUser: string,
	dbPass: string,
	dbName: string,
	tuneConfig: string | null,
	statsSettings: { trackIoTiming: boolean; trackWalIoTiming: boolean; trackActivities: boolean; trackCounts: boolean; trackFunctions: boolean }
): string {
	// Escape single quotes in password by ending quote, adding escaped quote, reopening
	const escapedPass = dbPass.replace(/'/g, "'\\''");

	const tuneBlock = tuneConfig
		? `
echo ""
echo "==> Writing performance tuning config to conf.d/mybench-tune.conf..."
PG_CONF_DIR=$(dirname "$PG_CONF")
sudo mkdir -p "$PG_CONF_DIR/conf.d"
# Enable include_dir in postgresql.conf if not already set
grep -q "^include_dir" "$PG_CONF" || echo "include_dir = 'conf.d'" | sudo tee -a "$PG_CONF"
sudo tee "$PG_CONF_DIR/conf.d/mybench-tune.conf" > /dev/null << 'TUNEEOF'
${tuneConfig}
TUNEEOF
echo "Tuning config written. Delete $PG_CONF_DIR/conf.d/mybench-tune.conf to revert."
`
		: `
echo ""
echo "==> Skipping performance tuning (no config provided)."
`;

	return `
set -e
echo "==> Finding PostgreSQL config files..."
PG_CONF=$(sudo -u postgres psql -t -c "SHOW config_file;" 2>/dev/null | xargs)
PG_HBA=$(sudo -u postgres psql -t -c "SHOW hba_file;" 2>/dev/null | xargs)
echo "postgresql.conf: $PG_CONF"
echo "pg_hba.conf:     $PG_HBA"

echo ""
echo "==> Setting listen_addresses = '*' (all interfaces)..."
sudo sed -i "s|^#*\\s*listen_addresses\\s*=.*|listen_addresses = '*'|" "$PG_CONF"
grep -q "^listen_addresses" "$PG_CONF" || echo "listen_addresses = '*'" | sudo tee -a "$PG_CONF"

echo ""
echo "==> Enabling pg_stat_statements in shared_preload_libraries..."
CURRENT_SPL=$(sudo -u postgres psql -t -c "SHOW shared_preload_libraries;" 2>/dev/null | xargs)
if echo "$CURRENT_SPL" | grep -q "pg_stat_statements"; then
  echo "pg_stat_statements already in shared_preload_libraries."
else
  sudo sed -i "s|^#*\\s*shared_preload_libraries\\s*=.*|shared_preload_libraries = 'pg_stat_statements'|" "$PG_CONF"
  grep -q "^shared_preload_libraries" "$PG_CONF" || echo "shared_preload_libraries = 'pg_stat_statements'" | sudo tee -a "$PG_CONF"
  echo "pg_stat_statements added to shared_preload_libraries."
fi

${tuneBlock}
echo ""
echo "==> Adding pg_hba.conf rules..."
if grep -qF "${clientPrivateIp}/32" "$PG_HBA"; then
  echo "Client VPC rule already present, skipping."
else
  echo "host    all    all    ${clientPrivateIp}/32    scram-sha-256" | sudo tee -a "$PG_HBA"
  echo "Client VPC rule added (${clientPrivateIp}/32)."
fi
if grep -qF "0.0.0.0/0" "$PG_HBA"; then
  echo "Public access rule already present, skipping."
else
  echo "host    all    all    0.0.0.0/0    scram-sha-256" | sudo tee -a "$PG_HBA"
  echo "Public access rule added (0.0.0.0/0, password required)."
fi

echo ""
echo "==> Restarting PostgreSQL..."
sudo systemctl restart postgresql
echo "PostgreSQL restarted successfully."

echo ""
echo "==> Applying statistics settings..."
sudo -u postgres psql -c "ALTER SYSTEM SET track_io_timing = ${statsSettings.trackIoTiming ? 'on' : 'off'};"
sudo -u postgres psql -c "ALTER SYSTEM SET track_wal_io_timing = ${statsSettings.trackWalIoTiming ? 'on' : 'off'};"
sudo -u postgres psql -c "ALTER SYSTEM SET track_activities = ${statsSettings.trackActivities ? 'on' : 'off'};"
sudo -u postgres psql -c "ALTER SYSTEM SET track_counts = ${statsSettings.trackCounts ? 'on' : 'off'};"
sudo -u postgres psql -c "ALTER SYSTEM SET track_functions = '${statsSettings.trackFunctions ? 'all' : 'none'}';"
sudo -u postgres psql -c "SELECT pg_reload_conf();"
echo "Statistics settings applied."

echo ""
echo "==> Configuring UFW: ensuring SSH stays open, then allowing port 5432..."
sudo ufw allow ssh comment 'SSH access'
sudo ufw allow from ${clientPrivateIp} to any port 5432 comment 'mybench client VPC'
sudo ufw allow 5432/tcp comment 'mybench public'
sudo ufw --force enable
sudo ufw status

echo ""
echo "==> Creating database user '${dbUser}' with superuser privileges (if not exists)..."
sudo -u postgres psql -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${dbUser}') THEN CREATE USER ${dbUser} WITH PASSWORD '${escapedPass}'; END IF; END \\$\\$;"
sudo -u postgres psql -c "ALTER USER ${dbUser} WITH SUPERUSER;"

echo ""
echo "==> Creating database '${dbName}' (if not exists)..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'" | grep -q 1 \\
  || sudo -u postgres psql -c "CREATE DATABASE ${dbName} OWNER ${dbUser};"

echo ""
echo "==> Installing pg_stat_statements extension..."
sudo -u postgres psql -d postgres -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
sudo -u postgres psql -d ${dbName} -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
echo "pg_stat_statements installed."

echo ""
echo "==> Configuration complete!"
`.trim();
}

/**
 * POST /api/onboard/configure-pg
 * Auto-configures PostgreSQL on the DB droplet. Streams output as SSE.
 * Body: { host, user, private_key, db_private_ip, client_private_ip, db_user, db_pass, db_name }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key, db_private_ip, client_private_ip, db_user, db_pass, db_name, tune_config,
		track_io_timing, track_wal_io_timing, track_activities, track_counts, track_functions } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');
	if (!db_private_ip) throw error(400, 'db_private_ip is required');
	if (!client_private_ip) throw error(400, 'client_private_ip is required');
	if (!db_pass) throw error(400, 'db_pass is required');

	const server = { id: 0, name: '', host, user: user ?? 'root', port: 22, private_key, remote_dir: '~', log_dir: '/tmp', vpc: '' };
	const statsSettings = {
		trackIoTiming: track_io_timing !== false,
		trackWalIoTiming: track_wal_io_timing !== false,
		trackActivities: track_activities !== false,
		trackCounts: track_counts !== false,
		trackFunctions: track_functions === true
	};
	const cmd = buildConfigureCmd(db_private_ip, client_private_ip, db_user ?? 'mybench', db_pass, db_name ?? 'mybench', tune_config ?? null, statsSettings);

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
