import { getActiveSuite } from '$lib/server/suite-executor';
import getDb from '$lib/server/db';
import type { RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = ({ params }) => {
	const suiteId = Number(params.id);
	const db = getDb();

	const suite = db.prepare('SELECT status FROM decision_suites WHERE id = ?').get(suiteId) as
		{ status: string } | undefined;
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
