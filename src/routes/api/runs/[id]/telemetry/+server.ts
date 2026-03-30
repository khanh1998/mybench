import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import { buildRunTelemetry } from '$lib/server/run-telemetry';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url }) => {
	const db = getDb();
	const runId = Number(params.id);
	if (!Number.isFinite(runId) || runId <= 0) throw error(400, 'Invalid run id');

	const phases = (url.searchParams.get('phases') ?? '')
		.split(',')
		.map((phase) => phase.trim())
		.filter(Boolean);

	try {
		return json(buildRunTelemetry(db, runId, phases));
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes('not found')) throw error(404, message);
		throw error(400, message);
	}
};
