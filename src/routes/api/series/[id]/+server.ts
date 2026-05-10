import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { completeRun } from '$lib/server/run-manager';
import { connectSsh, exec, shellQuote } from '$lib/server/ec2-runner';
import type { Ec2Server } from '$lib/types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const seriesId = Number(params.id);

	const series = db.prepare('SELECT * FROM benchmark_series WHERE id = ?').get(seriesId);
	if (!series) return json({ error: 'Series not found' }, { status: 404 });

	const runs = db.prepare(`
		SELECT id, status, profile_name, name, tps, latency_avg_ms, started_at, finished_at, series_id
		FROM benchmark_runs WHERE series_id = ? ORDER BY id
	`).all(seriesId);

	return json({ series, runs });
};

async function killRemoteProcess(ec2Server: Ec2Server, execLogPath: string): Promise<void> {
	const conn = await connectSsh(ec2Server);
	try {
		await exec(conn, `pkill -9 -f ${shellQuote(execLogPath)}`);
	} finally {
		conn.end();
	}
}

export const DELETE: RequestHandler = async ({ params, url }) => {
	const seriesId = Number(params.id);
	const db = getDb();
	const now = new Date().toISOString();

	if (url.searchParams.get('action') === 'delete') {
		const runningRuns = db.prepare(`SELECT id FROM benchmark_runs WHERE series_id = ? AND status = 'running'`).all(seriesId) as { id: number }[];
		for (const run of runningRuns) completeRun(run.id);
		db.prepare(`DELETE FROM benchmark_runs WHERE series_id = ?`).run(seriesId);
		db.prepare(`DELETE FROM benchmark_series WHERE id = ?`).run(seriesId);
	} else {
		const series = db.prepare(
			`SELECT bs.exec_log_path, br.ec2_server_id
			 FROM benchmark_series bs
			 LEFT JOIN benchmark_runs br ON br.series_id = bs.id AND br.ec2_server_id IS NOT NULL
			 WHERE bs.id = ? AND bs.status = 'running'
			 LIMIT 1`
		).get(seriesId) as { exec_log_path: string | null; ec2_server_id: number | null } | undefined;

		const runningRuns = db.prepare(`SELECT id FROM benchmark_runs WHERE series_id = ? AND status = 'running'`).all(seriesId) as { id: number }[];
		for (const run of runningRuns) completeRun(run.id);
		db.prepare(`UPDATE benchmark_series SET status='stopped', finished_at=? WHERE id=? AND status='running'`).run(now, seriesId);
		db.prepare(`UPDATE benchmark_runs SET status='stopped', finished_at=? WHERE series_id=? AND status IN ('running','pending')`).run(now, seriesId);

		if (series?.exec_log_path && series.ec2_server_id) {
			const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(series.ec2_server_id) as Ec2Server | undefined;
			if (ec2Server) {
				killRemoteProcess(ec2Server, series.exec_log_path).catch((err) => {
					console.warn(`[stop-series] Failed to kill remote process for series ${seriesId}:`, err instanceof Error ? err.message : err);
				});
			}
		}
	}

	return json({ ok: true });
};
