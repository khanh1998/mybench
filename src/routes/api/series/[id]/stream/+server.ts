import { getActiveSeries } from '$lib/server/series-executor';
import getDb from '$lib/server/db';
import type { RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = ({ params }) => {
	const seriesId = Number(params.id);
	const db = getDb();

	const series = db.prepare('SELECT * FROM benchmark_series WHERE id = ?').get(seriesId) as {
		status: string;
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

	// Active series — subscribe to emitter
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
