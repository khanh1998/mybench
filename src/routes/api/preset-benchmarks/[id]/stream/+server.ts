import { getActiveBenchmark, type SystemBenchmark, type SystemBenchmarkResult } from '$lib/server/preset-benchmark';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const benchmarkId = Number(params.id);
	const db = getDb();

	const benchmark = db.prepare('SELECT * FROM system_benchmarks WHERE id = ?').get(benchmarkId) as SystemBenchmark | undefined;
	if (!benchmark) {
		return new Response('Benchmark not found', { status: 404 });
	}

	const encoder = new TextEncoder();
	const headers = {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive'
	};

	// Completed/failed benchmark: replay results from DB
	if (benchmark.status !== 'running') {
		const results = db.prepare('SELECT * FROM system_benchmark_results WHERE benchmark_id = ? ORDER BY id').all(benchmarkId) as SystemBenchmarkResult[];

		const stream = new ReadableStream({
			start(controller) {
				const send = (event: string, data: unknown) => {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				};

				// Replay spec
				send('spec', {
					cpu_model: benchmark.cpu_model,
					cpu_cores: benchmark.cpu_cores,
					ram_mb: benchmark.ram_mb,
					storage_type: benchmark.storage_type,
					disk_size_gb: benchmark.disk_size_gb,
					os_version: benchmark.os_version,
					kernel_version: benchmark.kernel_version,
				});

				// Replay each result as test_done
				const total = results.length;
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					send('test_done', {
						index: i, total,
						category: r.test_category,
						threads: r.threads,
						metrics: JSON.parse(r.metrics_json),
						exitCode: r.exit_code,
					});
				}

				send('benchmark_done', {
					benchmarkId,
					status: benchmark.status,
					error: benchmark.error_message || undefined,
				});
				controller.close();
			}
		});
		return new Response(stream, { headers });
	}

	// Running benchmark: attach to emitter
	const active = getActiveBenchmark(benchmarkId);

	let onSpec: (data: unknown) => void;
	let onTestStart: (data: unknown) => void;
	let onTestDone: (data: unknown) => void;
	let onBenchmarkDone: (data: unknown) => void;

	const stream = new ReadableStream({
		start(controller) {
			const send = (event: string, data: unknown) => {
				try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
			};

			if (!active) {
				send('benchmark_done', { benchmarkId, status: 'unknown' });
				controller.close();
				return;
			}

			// Replay already-completed results from DB
			if (benchmark.cpu_cores > 0) {
				send('spec', {
					cpu_model: benchmark.cpu_model,
					cpu_cores: benchmark.cpu_cores,
					ram_mb: benchmark.ram_mb,
					storage_type: benchmark.storage_type,
					disk_size_gb: benchmark.disk_size_gb,
					os_version: benchmark.os_version,
					kernel_version: benchmark.kernel_version,
				});
			}

			const existingResults = db.prepare('SELECT * FROM system_benchmark_results WHERE benchmark_id = ? ORDER BY id').all(benchmarkId) as SystemBenchmarkResult[];
			for (let i = 0; i < existingResults.length; i++) {
				const r = existingResults[i];
				send('test_done', {
					index: i,
					category: r.test_category,
					threads: r.threads,
					metrics: JSON.parse(r.metrics_json),
					exitCode: r.exit_code,
				});
			}

			// Attach to live emitter
			onSpec = (data) => send('spec', data);
			onTestStart = (data) => send('test_start', data);
			onTestDone = (data) => send('test_done', data);
			onBenchmarkDone = (data) => {
				send('benchmark_done', data);
				try { controller.close(); } catch { /* already closed */ }
			};

			active.emitter.on('spec', onSpec);
			active.emitter.on('test_start', onTestStart);
			active.emitter.on('test_done', onTestDone);
			active.emitter.once('benchmark_done', onBenchmarkDone);
		},
		cancel() {
			if (active) {
				active.emitter.off('spec', onSpec);
				active.emitter.off('test_start', onTestStart);
				active.emitter.off('test_done', onTestDone);
				active.emitter.off('benchmark_done', onBenchmarkDone);
			}
		}
	});

	return new Response(stream, { headers });
};
