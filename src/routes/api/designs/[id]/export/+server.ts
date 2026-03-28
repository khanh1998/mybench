import { error } from '@sveltejs/kit';
import { generatePlan } from '$lib/server/plan-generator';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const designId = Number(params.id);

	const design = db.prepare('SELECT id FROM designs WHERE id = ?').get(designId);
	if (!design) throw error(404, 'Design not found');

	const plan = generatePlan(designId);

	return new Response(JSON.stringify(plan, null, 2), {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="design-${designId}-plan.json"`
		}
	});
};
