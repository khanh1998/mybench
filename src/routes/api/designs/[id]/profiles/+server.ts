import { json, error } from '@sveltejs/kit';
import getDb from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const db = getDb();
	const designId = Number(params.id);

	const profiles = db.prepare('SELECT * FROM design_param_profiles WHERE design_id = ? ORDER BY id').all(designId) as { id: number; design_id: number; name: string }[];
	const values = db.prepare(
		'SELECT * FROM design_param_profile_values WHERE profile_id IN (SELECT id FROM design_param_profiles WHERE design_id = ?) ORDER BY profile_id, id'
	).all(designId) as { id: number; profile_id: number; param_name: string; value: string }[];

	const valuesByProfile = new Map<number, { param_name: string; value: string }[]>();
	for (const v of values) {
		const arr = valuesByProfile.get(v.profile_id) ?? [];
		arr.push({ param_name: v.param_name, value: v.value });
		valuesByProfile.set(v.profile_id, arr);
	}

	return json(profiles.map(p => ({ ...p, values: valuesByProfile.get(p.id) ?? [] })));
};

export const POST: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	const designId = Number(params.id);
	const body = await request.json();
	const { name, values } = body as { name: string; values?: { param_name: string; value: string }[] };

	if (!name) throw error(400, 'Missing name');

	const result = db.transaction(() => {
		const r = db.prepare('INSERT INTO design_param_profiles (design_id, name) VALUES (?, ?)').run(designId, name);
		const profileId = r.lastInsertRowid as number;
		if (values?.length) {
			const ins = db.prepare('INSERT INTO design_param_profile_values (profile_id, param_name, value) VALUES (?, ?, ?)');
			for (const v of values) ins.run(profileId, v.param_name, v.value);
		}
		return profileId;
	})();

	return json({ profile_id: result }, { status: 201 });
};
