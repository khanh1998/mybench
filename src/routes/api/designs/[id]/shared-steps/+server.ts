import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';
import type { PgbenchScript } from '$lib/types';
import { listSharedSteps, shareStep, linkSharedStep, detachStep, unshareStep } from '$lib/server/shared-steps';

function decisionOf(designId: number): number {
	const row = getDb().prepare('SELECT decision_id FROM designs WHERE id = ?').get(designId) as { decision_id: number } | undefined;
	if (!row) throw error(404, 'Design not found');
	return row.decision_id;
}

function stepOfDesign(designId: number, stepId: number) {
	const row = getDb().prepare('SELECT id, shared_step_id FROM design_steps WHERE id = ? AND design_id = ?').get(stepId, designId) as { id: number; shared_step_id: number | null } | undefined;
	if (!row) throw error(404, 'Step not found in this design');
	return row;
}

/** Shared steps of this design's decision, with the designs using each. */
export const GET: RequestHandler = ({ params }) => json(listSharedSteps(decisionOf(Number(params.id))));

type Body =
	| { action: 'share'; step_id: number }
	| { action: 'link'; shared_step_id: number; position?: number }
	| { action: 'detach'; step_id: number }
	| { action: 'unshare'; shared_step_id: number };

export const POST: RequestHandler = async ({ params, request }) => {
	const designId = Number(params.id);
	const decisionId = decisionOf(designId);
	const body = (await request.json()) as Body;
	const db = getDb();
	try {
		switch (body.action) {
			case 'share': {
				stepOfDesign(designId, body.step_id);
				const sharedStepId = shareStep(body.step_id);
				return json({ shared_step_id: sharedStepId, shared_steps: listSharedSteps(decisionId) });
			}
			case 'link': {
				const stepId = linkSharedStep(designId, body.shared_step_id, body.position);
				const step = db.prepare('SELECT * FROM design_steps WHERE id = ?').get(stepId) as { type: string };
				const scripts = db.prepare('SELECT * FROM pgbench_scripts WHERE step_id = ? ORDER BY position').all(stepId) as PgbenchScript[];
				return json({ step: { ...step, pgbench_scripts: step.type === 'pgbench' ? scripts : undefined }, shared_steps: listSharedSteps(decisionId) });
			}
			case 'detach':
				stepOfDesign(designId, body.step_id);
				detachStep(body.step_id);
				return json({ shared_steps: listSharedSteps(decisionId) });
			case 'unshare': {
				const owner = db.prepare('SELECT decision_id FROM shared_steps WHERE id = ?').get(body.shared_step_id) as { decision_id: number } | undefined;
				if (!owner || owner.decision_id !== decisionId) throw error(404, 'Shared step not found in this decision');
				const linked = unshareStep(body.shared_step_id);
				return json({ unlinked: linked, shared_steps: listSharedSteps(decisionId) });
			}
			default:
				throw error(400, 'Unknown action');
		}
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(409, (e as Error).message);
	}
};
