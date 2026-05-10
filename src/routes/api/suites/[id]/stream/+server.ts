import { getActiveSuite } from '$lib/server/suite-executor';
import { connectSsh, execStreamingCancellable, shellQuote } from '$lib/server/ec2-runner';
import getDb from '$lib/server/db';
import type { Ec2Server } from '$lib/types';
import type { RequestHandler } from '@sveltejs/kit';

const MB_PREFIX = '__MB__';

export const GET: RequestHandler = ({ params }) => {
	const suiteId = Number(params.id);
	const db = getDb();

	const suite = db.prepare('SELECT * FROM decision_suites WHERE id = ?').get(suiteId) as {
		status: string; exec_log_path: string;
	} | undefined;
	if (!suite) return new Response('Suite not found', { status: 404 });

	const encoder = new TextEncoder();

	if (suite.status !== 'running') {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(`event: done\ndata: ${suite.status}\n\n`));
				controller.close();
			}
		});
		return new Response(stream, {
			headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
		});
	}

	// Active suite with exec_log_path — tail for refresh-safe streaming
	if (suite.exec_log_path) {
		// Resolve EC2 server via any run in this suite
		const runRow = db.prepare(`
			SELECT br.ec2_server_id FROM benchmark_runs br
			JOIN benchmark_series bs ON br.series_id = bs.id
			WHERE bs.suite_id = ? LIMIT 1
		`).get(suiteId) as { ec2_server_id: number | null } | undefined;
		const ec2Server = runRow?.ec2_server_id
			? db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(runRow.ec2_server_id) as Ec2Server | undefined
			: undefined;

		// Pre-load series info for emitting series-done when all runs in a design complete
		const seriesList = db.prepare(`
			SELECT bs.id AS series_id, bs.design_id,
			       COUNT(br.id) AS total_runs
			FROM benchmark_series bs
			LEFT JOIN benchmark_runs br ON br.series_id = bs.id
			WHERE bs.suite_id = ?
			GROUP BY bs.id
			ORDER BY bs.id
		`).all(suiteId) as { series_id: number; design_id: number; total_runs: number }[];

		// Build flat run list (same order as the series command's run_index)
		const flatRuns = db.prepare(`
			SELECT br.id, br.series_id FROM benchmark_runs br
			JOIN benchmark_series bs ON br.series_id = bs.id
			WHERE bs.suite_id = ? ORDER BY bs.id, br.id
		`).all(suiteId) as { id: number; series_id: number }[];

		if (ec2Server) {
			let stopTail: (() => void) | null = null;
			const stream = new ReadableStream({
				async start(controller) {
					const send = (event: string, data: unknown) => {
						try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
					};
					const sendLine = (line: string) => {
						try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); } catch { /* closed */ }
					};

					// Track run_done count per series to emit series-done at the right time
					const seriesRunDone = new Map<number, number>();
					const seriesRunTotal = new Map<number, number>();
					for (const s of seriesList) {
						seriesRunDone.set(s.series_id, 0);
						seriesRunTotal.set(s.series_id, s.total_runs);
					}

					let conn: import('ssh2').Client | null = null;
					try {
						conn = await connectSsh(ec2Server);
						const { promise, cancel } = execStreamingCancellable(
							conn,
							`timeout 86400 tail -n +1 -F ${shellQuote(suite.exec_log_path)}`,
							(line) => {
								if (line.startsWith(MB_PREFIX)) {
									try {
										const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
										if (evt.event === 'run_done') {
											const runIndex = evt.run_index as number | undefined;
											if (runIndex !== undefined) {
												const seriesId = flatRuns[runIndex]?.series_id;
												if (seriesId !== undefined) {
													const done = (seriesRunDone.get(seriesId) ?? 0) + 1;
													seriesRunDone.set(seriesId, done);
													if (done === seriesRunTotal.get(seriesId)) {
														const si = seriesList.findIndex(s => s.series_id === seriesId);
														send('series-done', { series_id: seriesId, design_id: seriesList[si]?.design_id ?? 0, index: si });
													}
												}
											}
										} else if (evt.event === 'series_done') {
											cancel();
											const s = db.prepare('SELECT status FROM decision_suites WHERE id = ?').get(suiteId) as { status: string } | undefined;
											send('done', s?.status ?? 'completed');
											try { controller.close(); } catch { /* already closed */ }
										}
									} catch { /* malformed */ }
									return;
								}
								sendLine(line);
							}
						);
						stopTail = cancel;
						await promise;
					} catch (err) {
						sendLine(`[stream error] ${err instanceof Error ? err.message : String(err)}`);
						try { controller.close(); } catch { /* already closed */ }
					} finally {
						conn?.end();
					}
				},
				cancel() {
					stopTail?.();
				}
			});
			return new Response(stream, {
				headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
			});
		}
	}

	// Fallback: EventEmitter-based path
	const activeEmitter = getActiveSuite(suiteId);

	let onLine: (line: string) => void;
	let onSeriesDone: (data: object) => void;
	let onDone: () => void;

	const stream = new ReadableStream({
		start(controller) {
			if (!activeEmitter) {
				controller.enqueue(encoder.encode(`event: done\ndata: unknown\n\n`));
				controller.close();
				return;
			}

			onLine = (line: string) => {
				try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); } catch {}
			};
			onSeriesDone = (data: object) => {
				try { controller.enqueue(encoder.encode(`event: series-done\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
			};
			onDone = () => {
				const s = db.prepare('SELECT status FROM decision_suites WHERE id = ?').get(suiteId) as { status: string } | undefined;
				try {
					controller.enqueue(encoder.encode(`event: done\ndata: ${s?.status ?? 'completed'}\n\n`));
					controller.close();
				} catch {}
			};

			activeEmitter.on('line', onLine);
			activeEmitter.on('series-done', onSeriesDone);
			activeEmitter.once('done', onDone);
		},
		cancel() {
			activeEmitter?.off('line', onLine);
			activeEmitter?.off('series-done', onSeriesDone);
			activeEmitter?.off('done', onDone);
		}
	});

	return new Response(stream, {
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
	});
};
