import { error, json } from '@sveltejs/kit';
import { connectSsh, exec } from '$lib/server/ec2-runner';
import { buildPerfInspectCommand, parsePerfInspectOutput } from '$lib/server/perf-inspect';
import type { RequestHandler } from './$types';

/**
 * POST /api/onboard/inspect
 * Checks installed dependencies on a droplet via SSH.
 * Body: { host, user, private_key, role: 'client' | 'db' }
 * Returns: { ok, tools: { [name]: { ok, version?, error? } } }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { host, user, private_key, role } = body;
	if (!host) throw error(400, 'host is required');
	if (!private_key) throw error(400, 'private_key is required');
	if (!role || !['client', 'db'].includes(role)) throw error(400, 'role must be client or db');

	const server = { id: 0, name: '', host, user: user ?? 'root', port: 22, private_key, remote_dir: '~/mybench-bench', log_dir: '/tmp/mybench-logs', vpc: '' };

	let conn;
	try {
		conn = await connectSsh(server);
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}

	try {
		const tools: Record<string, { ok: boolean; version?: string; error?: string }> = {};

		if (role === 'client') {
			// mybench-runner: check for binary in ~/mybench-bench/
			const homeRes = await exec(conn, 'echo $HOME');
			const home = homeRes.stdout.trim();
			const binaryPath = `${home}/mybench-bench/mybench-runner`;
			// Use exit-code–preserving pattern: on failure, exit 1 so code !== 0 is reliable
			const binCheck = await exec(conn, `test -x '${binaryPath}' && '${binaryPath}' --version 2>&1 || exit 1`);
			tools['mybench-runner'] = binCheck.code !== 0
				? { ok: false, error: 'not found at ~/mybench-bench/mybench-runner' }
				: { ok: true, version: binCheck.stdout.trim() };

			// pgbench — `pgbench --version` may print an error then exit non-zero if binary is missing
			const pgbenchRes = await exec(conn, 'pgbench --version 2>&1 || exit 1');
			tools['pgbench'] = pgbenchRes.code !== 0
				? { ok: false, error: pgbenchRes.stdout.trim() || 'not found on PATH' }
				: { ok: true, version: pgbenchRes.stdout.trim() };

			// sysbench
			const sysbenchRes = await exec(conn, 'sysbench --version 2>&1 || exit 1');
			tools['sysbench'] = sysbenchRes.code !== 0
				? { ok: false, error: 'not found on PATH' }
				: { ok: true, version: sysbenchRes.stdout.trim() };
		} else {
			// postgresql
			const pgRes = await exec(conn, 'psql --version 2>&1 || exit 1');
			tools['postgresql'] = pgRes.code !== 0
				? { ok: false, error: 'not installed (psql not found on PATH)' }
				: { ok: true, version: pgRes.stdout.trim() };

			const perfRes = await exec(conn, buildPerfInspectCommand());
			const perf = parsePerfInspectOutput(`${perfRes.stdout}\n${perfRes.stderr}`);
			tools['perf'] = perf.perf_installed
				? { ok: true, version: perf.perf_version }
				: { ok: false, error: perf.error || 'not installed' };
			return json({ ok: true, tools, perf });
		}

		return json({ ok: true, tools });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
	} finally {
		conn.end();
	}
};
