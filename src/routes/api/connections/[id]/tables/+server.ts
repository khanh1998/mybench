import { json, error } from '@sveltejs/kit';
import { getPgServerTableSelections, setPgServerTableSelections } from '$lib/server/services/pg-servers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	try {
		return json(getPgServerTableSelections(Number(params.id)));
	} catch (err) {
		throw error(404, err instanceof Error ? err.message : String(err));
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await request.json() as { table_name: string; enabled: boolean }[];
	try {
		setPgServerTableSelections(Number(params.id), body);
		return json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw error(message.includes('not found') ? 404 : 400, message);
	}
};
