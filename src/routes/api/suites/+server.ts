import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { startSuite } from '$lib/server/suite-executor';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const {
		decision_id,
		designs,
		delay_seconds,
		name,
		ec2_server_id,
		server_id,
		database,
		use_private_ip
	} = body;

	if (!decision_id || !Array.isArray(designs) || designs.length === 0) {
		return json({ error: 'decision_id and designs (non-empty array) are required' }, { status: 400 });
	}
	for (const d of designs) {
		if (!d.design_id || !Array.isArray(d.decision_profile_ids) || d.decision_profile_ids.length < 1) {
			return json({ error: 'Each design entry needs design_id and at least one decision_profile_id' }, { status: 400 });
		}
	}

	try {
		const suiteId = startSuite({
			decision_id: Number(decision_id),
			designs: designs.map((d: { design_id: number; decision_profile_ids: number[] }) => ({
				design_id: Number(d.design_id),
				decision_profile_ids: d.decision_profile_ids.map(Number)
			})),
			delay_seconds: Number(delay_seconds ?? 0),
			name: name || undefined,
			ec2_server_id: ec2_server_id ? Number(ec2_server_id) : null,
			server_id: server_id ? Number(server_id) : undefined,
			database: database || undefined,
			use_private_ip: !!use_private_ip
		});
		return json({ suite_id: suiteId }, { status: 201 });
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
	}
};
