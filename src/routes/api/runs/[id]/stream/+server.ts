import { getActiveRun } from '$lib/server/run-manager';
import { connectSsh, execStreamingCancellable, shellQuote } from '$lib/server/ec2-runner';
import getDb from '$lib/server/db';
import type { Ec2Server } from '$lib/types';
import type { RequestHandler } from './$types';

const MB_PREFIX = '__MB__';

export const GET: RequestHandler = ({ params }) => {
	const runId = Number(params.id);
	const db = getDb();

	const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(runId) as {
		status: string; exec_log_path: string; ec2_server_id: number | null;
	} | undefined;
	if (!run) {
		return new Response('Run not found', { status: 404 });
	}

	const encoder = new TextEncoder();

	// If run is already done, replay stored output and send done
	if (run.status !== 'running') {
		const steps = db.prepare('SELECT * FROM run_step_results WHERE run_id = ? ORDER BY position').all(runId) as {
			name: string; stdout: string; stderr: string;
		}[];
		const stream = new ReadableStream({
			start(controller) {
				for (const step of steps) {
					if (step.stdout) {
						for (const line of step.stdout.split('\n').filter(Boolean)) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
						}
					}
					if (step.stderr) {
						for (const line of step.stderr.split('\n').filter(Boolean)) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify('[stderr] ' + line)}\n\n`));
						}
					}
				}
				controller.enqueue(encoder.encode(`event: done\ndata: ${run.status}\n\n`));
				controller.close();
			}
		});
		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive'
			}
		});
	}

	// Active run with exec_log_path — tail the file over SSH for refresh-safe streaming
	if (run.exec_log_path && run.ec2_server_id) {
		const ec2Server = db.prepare('SELECT * FROM ec2_servers WHERE id = ?').get(run.ec2_server_id) as Ec2Server | undefined;

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
							`timeout 86400 tail -n +1 -F ${shellQuote(run.exec_log_path)}`,
							(line) => {
								if (line.startsWith(MB_PREFIX)) {
									try {
										const evt = JSON.parse(line.slice(MB_PREFIX.length)) as Record<string, unknown>;
										if (evt.event === 'step_start' || evt.event === 'step_done') {
											send('step', evt);
										} else if (evt.event === 'phase') {
											send('phase', evt);
										} else if (evt.event === 'run_done') {
											cancel();
											const r = db.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId) as { status: string } | undefined;
											send('done', r?.status ?? 'completed');
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
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive'
				}
			});
		}
	}

	// Fallback: EventEmitter-based path (no exec_log_path or no ec2_server)
	const activeRun = getActiveRun(runId);

	let onLine: (line: string) => void;
	let onStep: (data: object) => void;
	let onPhase: (data: object) => void;
	let onDone: () => void;

	const stream = new ReadableStream({
		start(controller) {
			if (!activeRun) {
				controller.enqueue(encoder.encode(`event: done\ndata: unknown\n\n`));
				controller.close();
				return;
			}

			// Replay any stdout already flushed to DB
			const storedSteps = db.prepare(
				'SELECT stdout FROM run_step_results WHERE run_id = ? ORDER BY position'
			).all(runId) as { stdout: string | null }[];
			for (const step of storedSteps) {
				if (step.stdout) {
					for (const line of step.stdout.split('\n').filter(Boolean)) {
						try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); } catch {}
					}
				}
			}

			if (activeRun.currentPhase) {
				try { controller.enqueue(encoder.encode(`event: phase\ndata: ${JSON.stringify(activeRun.currentPhase)}\n\n`)); } catch {}
			}

			onLine = (line: string) => {
				try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); } catch {}
			};
			onStep = (data: object) => {
				try { controller.enqueue(encoder.encode(`event: step\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
			};
			onPhase = (data: object) => {
				try { controller.enqueue(encoder.encode(`event: phase\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
			};
			onDone = () => {
				const r = db.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId) as { status: string } | undefined;
				try {
					controller.enqueue(encoder.encode(`event: done\ndata: ${r?.status ?? 'completed'}\n\n`));
					controller.close();
				} catch {}
			};

			activeRun.emitter.on('line', onLine);
			activeRun.emitter.on('step', onStep);
			activeRun.emitter.on('phase', onPhase);
			activeRun.emitter.once('done', onDone);
		},
		cancel() {
			activeRun?.emitter.off('line', onLine);
			activeRun?.emitter.off('step', onStep);
			activeRun?.emitter.off('phase', onPhase);
			activeRun?.emitter.off('done', onDone);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		}
	});
};
