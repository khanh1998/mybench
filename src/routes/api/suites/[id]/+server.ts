import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { completeRun } from '$lib/server/run-manager';
import { connectSsh, exec, shellQuote } from '$lib/server/ec2-runner';
import type { Ec2Server } from '$lib/types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const suiteId = Number(params.id);

	const suite = db.prepare(`
		SELECT ds.*, dec.name AS decision_name
		FROM decision_suites ds
		JOIN decisions dec ON ds.decision_id = dec.id
		WHERE ds.id = ?
	`).get(suiteId) as Record<string, unknown> | undefined;
	if (!suite) return json({ error: 'Suite not found' }, { status: 404 });

	const seriesList = db.prepare(`
		SELECT bs.*, d.name AS design_name
		FROM benchmark_series bs
		JOIN designs d ON bs.design_id = d.id
		WHERE bs.suite_id = ?
		ORDER BY bs.id ASC
	`).all(suiteId) as Record<string, unknown>[];

	const seriesIds = seriesList.map(s => s.id as number);
	const runs = seriesIds.length > 0
		? db.prepare(`
				SELECT id, series_id, design_id, status, profile_name, tps, latency_avg_ms, started_at, finished_at
				FROM benchmark_runs
				WHERE series_id IN (${seriesIds.join(',')})
				ORDER BY id ASC
		`).all() as Record<string, unknown>[]
		: [];

	return json({ suite, seriesList, runs });
};

async function killRemoteProcess(ec2Server: Ec2Server, execLogPath: string): Promise<void> {
	const conn = await connectSsh(ec2Server);
	try {
		await exec(conn, `pkill -9 -f ${shellQuote(execLogPath)}`);
		await exec(conn, `pkill -9 sysbench`);
		await exec(conn, `pkill -9 pgbench`);
	} finally {
		conn.end();
	}
}

export const DELETE: RequestHandler = async ({ params, url }) => {
	const suiteId = Number(params.id);
	const db = getDb();
	const now = new Date().toISOString();
	const seriesIds = (db.prepare(`SELECT id FROM benchmark_series WHERE suite_id = ?`).all(suiteId) as { id: number }[]).map(s => s.id);

	if (url.searchParams.get('action') === 'delete') {
		if (seriesIds.length > 0) {
			const runningRuns = db.prepare(`SELECT id FROM benchmark_runs WHERE series_id IN (${seriesIds.join(',')}) AND status = 'running'`).all() as { id: number }[];
			for (const run of runningRuns) completeRun(run.id);
			db.prepare(`DELETE FROM benchmark_runs WHERE series_id IN (${seriesIds.join(',')})`).run();
			db.prepare(`DELETE FROM benchmark_series WHERE suite_id = ?`).run(suiteId);
		}
		db.prepare(`DELETE FROM decision_suites WHERE id = ?`).run(suiteId);
	} else {
		const suite = db.prepare(
			`SELECT ds.exec_log_path, br.ec2_server_id
			 FROM decision_suites ds
			 LEFT JOIN benchmark_series bs ON bs.suite_id = ds.id
			 LEFT JOIN benchmark_runs br ON br.series_id = bs.id AND br.ec2_server_id IS NOT NULL
			 WHERE ds.id = ? AND ds.status = 'running'
			 LIMIT 1`
		).get(suiteId) as { exec_log_path: string | null; ec2_server_id: number | null } | undefined;

		if (seriesIds.length > 0) {
			const runningRuns = db.prepare(`SELECT id FROM benchmark_runs WHERE series_id IN (${seriesIds.join(',')}) AND status = 'running'`).all() as { id: number }[];
			for (const run of runningRuns) completeRun(run.id);
			db.prepare(`UPDATE benchmark_runs SET status='stopped', finished_at=? WHERE series_id IN (${seriesIds.join(',')}) AND status IN ('running','pending')`).run(now);
			db.prepare(`UPDATE benchmark_series SET status='stopped', finished_at=? WHERE suite_id=? AND status IN ('running','pending')`).run(now, suiteId);
		}
		db.prepare(`UPDATE decision_suites SET status='stopped', finished_at=? WHERE id=? AND status='running'`).run(now, suiteId);

		if (suite?.exec_log_path && suite.ec2_server_id) {
			const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(suite.ec2_server_id) as Ec2Server | undefined;
			if (ec2Server) {
				killRemoteProcess(ec2Server, suite.exec_log_path).catch((err) => {
					console.warn(`[stop-suite] Failed to kill remote process for suite ${suiteId}:`, err instanceof Error ? err.message : err);
				});
			}
		}
	}

	return json({ ok: true });
};
