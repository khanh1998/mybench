import { getActiveSeries } from '$lib/server/series-executor';
import { connectSsh, execStreamingCancellable, shellQuote } from '$lib/server/ec2-runner';
import getDb from '$lib/server/db';
import type { Ec2Server } from '$lib/types';
import type { RequestHandler } from '@sveltejs/kit';

const MB_PREFIX = '__MB__';

export const GET: RequestHandler = ({ params }) => {
	const seriesId = Number(params.id);
	const db = getDb();

	const series = db.prepare('SELECT * FROM benchmark_series WHERE id = ?').get(seriesId) as {
		status: string; exec_log_path: string; design_id: number;
	} | undefined;
	if (!series) return new Response('Series not found', { status: 404 });

	const encoder = new TextEncoder();

	// If series is already done, replay all run outputs and send done
	if (series.status !== 'running') {
		const runs = db.prepare(`
			SELECT id, profile_name, status FROM benchmark_runs WHERE series_id = ? ORDER BY id
		`).all(seriesId) as { id: number; profile_name: string; status: string }[];

		const stream = new ReadableStream({
			start(controller) {
				for (const run of runs) {
					const steps = db.prepare(
						'SELECT name, stdout, stderr FROM run_step_results WHERE run_id = ? ORDER BY position'
					).all(run.id) as { name: string; stdout: string; stderr: string }[];

					controller.enqueue(encoder.encode(
						`data: ${JSON.stringify(`\n=== Run: ${run.profile_name} ===`)}\n\n`
					));
					for (const step of steps) {
						if (step.stdout) {
							for (const line of step.stdout.split('\n').filter(Boolean)) {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
							}
						}
					}
				}
				controller.enqueue(encoder.encode(`event: done\ndata: ${series.status}\n\n`));
				controller.close();
			}
		});
		return new Response(stream, {
			headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
		});
	}

	// Active series with exec_log_path — tail for refresh-safe streaming
	if (series.exec_log_path) {
		// Resolve EC2 server via any run in this series
		const runRow = db.prepare('SELECT ec2_server_id FROM benchmark_runs WHERE series_id = ? LIMIT 1').get(seriesId) as { ec2_server_id: number | null } | undefined;
		const ec2Server = runRow?.ec2_server_id
			? db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(runRow.ec2_server_id) as Ec2Server | undefined
			: undefined;

		// Pre-load run ids in order so we can resolve run_index → run_id for progress events
		const seriesRuns = db.prepare('SELECT id FROM benchmark_runs WHERE series_id = ? ORDER BY id').all(seriesId) as { id: number }[];

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

					let conn: import('ssh2').Client | null = null;
					try {
						conn = await connectSsh(ec2Server);
						const { promise, cancel } = execStreamingCancellable(
							conn,
							`timeout 86400 tail -n +1 -F ${shellQuote(series.exec_log_path)}`,
							(line) => {
								if (line.startsWith(MB_PREFIX)) {
									try {
										const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
										if (evt.event === 'run_start') {
											const runIndex = evt.run_index as number | undefined;
											const currentRunId = runIndex !== undefined ? (seriesRuns[runIndex]?.id ?? null) : null;
											send('progress', {
												current: (runIndex ?? 0) + 1,
												total: seriesRuns.length,
												current_run_id: currentRunId
											});
										} else if (evt.event === 'series_done') {
											cancel();
											const s = db.prepare('SELECT status FROM benchmark_series WHERE id = ?').get(seriesId) as { status: string } | undefined;
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
	const activeSeriesEmitter = getActiveSeries(seriesId);

	let onLine: (line: string) => void;
	let onProgress: (data: object) => void;
	let onDone: () => void;

	const stream = new ReadableStream({
		start(controller) {
			if (!activeSeriesEmitter) {
				controller.enqueue(encoder.encode(`event: done\ndata: unknown\n\n`));
				controller.close();
				return;
			}

			onLine = (line: string) => {
				try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); } catch {}
			};
			onProgress = (data: object) => {
				try { controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
			};
			onDone = () => {
				const s = db.prepare('SELECT status FROM benchmark_series WHERE id = ?').get(seriesId) as { status: string } | undefined;
				try {
					controller.enqueue(encoder.encode(`event: done\ndata: ${s?.status ?? 'completed'}\n\n`));
					controller.close();
				} catch {}
			};

			activeSeriesEmitter.on('line', onLine);
			activeSeriesEmitter.on('progress', onProgress);
			activeSeriesEmitter.once('done', onDone);
		},
		cancel() {
			activeSeriesEmitter?.off('line', onLine);
			activeSeriesEmitter?.off('progress', onProgress);
			activeSeriesEmitter?.off('done', onDone);
		}
	});

	return new Response(stream, {
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
	});
};
