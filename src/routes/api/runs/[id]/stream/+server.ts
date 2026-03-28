import { getActiveRun } from '$lib/server/run-manager';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const runId = Number(params.id);
	const db = getDb();

	const run = db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(runId) as { status: string } | undefined;
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

	// Active run — subscribe to emitter
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

			// Replay any stdout already flushed to DB (e.g. EC2 runs flush every 50 lines,
			// so a page reload mid-run will catch up on past output before subscribing to live events)
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

			// Replay current phase for late connects (page refresh mid-phase)
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
