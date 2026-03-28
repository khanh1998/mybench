import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const db = getDb();
	const body = await request.json();

	const { design_id, result } = body;

	if (!design_id) throw error(400, 'Missing design_id');
	if (!result) throw error(400, 'Missing result');
	if (!result.run) throw error(400, 'Missing result.run');

	const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(Number(design_id));
	if (!design) throw error(400, 'Design not found');

	const run = result.run as {
		status: string;
		started_at: string;
		finished_at: string;
		bench_started_at?: string;
		post_started_at?: string;
		snapshot_interval_seconds?: number;
		pre_collect_secs?: number;
		post_collect_secs?: number;
		tps?: number;
		latency_avg_ms?: number;
		latency_stddev_ms?: number;
		transactions?: number;
		profile_name?: string;
		params?: Array<{ name: string; value: string }>;
	};

	// Ensure is_imported column exists
	const runCols = (db.prepare(`PRAGMA table_info(benchmark_runs)`).all() as { name: string }[]).map(c => c.name);
	if (!runCols.includes('is_imported')) {
		db.exec(`ALTER TABLE benchmark_runs ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 0`);
	}
	if (!runCols.includes('profile_name')) {
		db.exec(`ALTER TABLE benchmark_runs ADD COLUMN profile_name TEXT NOT NULL DEFAULT ''`);
	}
	if (!runCols.includes('run_params')) {
		db.exec(`ALTER TABLE benchmark_runs ADD COLUMN run_params TEXT NOT NULL DEFAULT ''`);
	}

	// Insert benchmark_run record
	const insertResult = db.prepare(`
		INSERT INTO benchmark_runs (
			design_id, status, started_at, finished_at,
			bench_started_at, post_started_at,
			snapshot_interval_seconds, pre_collect_secs, post_collect_secs,
			tps, latency_avg_ms, latency_stddev_ms, transactions,
			is_imported, profile_name, run_params
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
	`).run(
		Number(design_id),
		run.status ?? 'completed',
		run.started_at ?? new Date().toISOString(),
		run.finished_at ?? new Date().toISOString(),
		run.bench_started_at ?? null,
		run.post_started_at ?? null,
		run.snapshot_interval_seconds ?? 30,
		run.pre_collect_secs ?? 0,
		run.post_collect_secs ?? 60,
		run.tps ?? null,
		run.latency_avg_ms ?? null,
		run.latency_stddev_ms ?? null,
		run.transactions ?? null,
		run.profile_name ?? '',
		run.params ? JSON.stringify(run.params) : ''
	);

	const runId = insertResult.lastInsertRowid as number;

	// Insert step results
	const steps = result.steps as {
		step_id: number; position: number; name: string; type: string;
		status: string; command?: string; log?: string; started_at: string; finished_at: string;
	}[] | undefined;
	if (steps?.length) {
		const insStep = db.prepare(`
			INSERT INTO run_step_results (run_id, step_id, position, name, type, status, command, stdout, started_at, finished_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		db.transaction(() => {
			for (const s of steps) {
				insStep.run(runId, s.step_id, s.position, s.name, s.type, s.status, s.command ?? '', s.log ?? '', s.started_at, s.finished_at);
			}
		})();
	}

	// Insert snapshots
	const snapshots = result.snapshots as Record<string, Record<string, unknown>[]> | undefined;
	if (snapshots) {
		for (const [snapTableName, rows] of Object.entries(snapshots)) {
			if (!Array.isArray(rows) || rows.length === 0) continue;

			// Create table if it doesn't exist
			db.exec(`CREATE TABLE IF NOT EXISTS ${snapTableName} (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER,
				_collected_at TEXT,
				_phase TEXT
			)`);

			// Get existing columns
			const existingCols = new Set(
				(db.prepare(`PRAGMA table_info(${snapTableName})`).all() as { name: string }[]).map(r => r.name)
			);

			// Get all data column names from first row (excluding meta columns)
			const metaCols = new Set(['_collected_at', '_phase', '_is_baseline']);
			const firstRow = rows[0];
			const dataCols = Object.keys(firstRow).filter(k => !metaCols.has(k));

			// Add missing columns
			for (const col of dataCols) {
				if (!existingCols.has(col)) {
					db.exec(`ALTER TABLE ${snapTableName} ADD COLUMN ${col} TEXT`);
				}
			}

			// Build insert statement
			const insertCols = ['_run_id', '_collected_at', '_phase', ...dataCols];
			const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
			const stmt = db.prepare(
				`INSERT INTO ${snapTableName} (${insertCols.join(', ')}) VALUES (${placeholders})`
			);

			const insertMany = db.transaction((rowsToInsert: Record<string, unknown>[]) => {
				for (const row of rowsToInsert) {
					const params: Record<string, unknown> = {
						p0: runId,
						p1: row['_collected_at'] ?? new Date().toISOString(),
						p2: row['_phase'] ?? 'bench'
					};
					dataCols.forEach((col, i) => {
						params[`p${i + 3}`] = row[col] ?? null;
					});
					stmt.run(params);
				}
			});

			insertMany(rows);
		}
	}

	return json({ run_id: runId });
};
