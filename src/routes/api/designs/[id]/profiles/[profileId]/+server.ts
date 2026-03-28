import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const profileId = Number(params.profileId);
	const body = await request.json();
	const { name, values } = body as { name?: string; values?: { param_name: string; value: string }[] };

	const profile = db.prepare('SELECT * FROM design_param_profiles WHERE id = ?').get(profileId);
	if (!profile) throw error(404, 'Profile not found');

	db.transaction(() => {
		if (name !== undefined) db.prepare('UPDATE design_param_profiles SET name = ? WHERE id = ?').run(name, profileId);
		if (values !== undefined) {
			db.prepare('DELETE FROM design_param_profile_values WHERE profile_id = ?').run(profileId);
			const ins = db.prepare('INSERT INTO design_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
			for (const v of values) ins.run(profileId, v.param_name, v.value);
		}
	})();

	return json({ updated: true, profile_id: profileId });
};

export const DELETE: RequestHandler = ({ params }) => {
	const db = getDb();
	const profileId = Number(params.profileId);

	const profile = db.prepare('SELECT * FROM design_param_profiles WHERE id = ?').get(profileId);
	if (!profile) throw error(404, 'Profile not found');

	db.prepare('DELETE FROM design_param_profiles WHERE id = ?').run(profileId);
	return json({ deleted: true, profile_id: profileId });
};
