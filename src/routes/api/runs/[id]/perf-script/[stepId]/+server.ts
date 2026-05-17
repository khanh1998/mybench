import { error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { readFileSync } from 'fs';
import { resolve, sep } from 'path';
import type { RequestHandler } from './$types';

const PERF_SCRIPT_PATH_PREFIX = 'data/perf/';
const PERF_SCRIPT_DIR = resolve(process.cwd(), 'data', 'perf');

function readPerfScriptOutput(value: string): string {
	if (!value.startsWith(PERF_SCRIPT_PATH_PREFIX)) return value;

	const path = resolve(process.cwd(), value);
	if (path !== PERF_SCRIPT_DIR && !path.startsWith(`${PERF_SCRIPT_DIR}${sep}`)) {
		throw error(404, 'Perf script not found');
	}

	try {
		return readFileSync(path, 'utf8');
	} catch {
		throw error(404, 'Perf script not found');
	}
}

export const GET: RequestHandler = ({ params, url }) => {
	const runId = Number(params.id);
	const stepId = Number(params.stepId);
	const mode = url.searchParams.get('mode') ?? 'record';
	const db = getDb();
	const row = db.prepare(`
		SELECT perf_script_output
		FROM run_step_perf
		WHERE run_id = ? AND step_id = ? AND mode = ?
	`).get(runId, stepId, mode) as { perf_script_output: string } | undefined;
	if (!row) throw error(404, 'Perf script not found');

	return new Response(readPerfScriptOutput(row.perf_script_output ?? ''), {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': `attachment; filename="run-${runId}-step-${stepId}-${mode}.perf-script.txt"`
		}
	});
};
