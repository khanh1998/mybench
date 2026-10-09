import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { shareParam, unshareParam, shareProfile, unshareProfile, getSiblingUsage } from '$lib/server/param-sharing';

/** Sibling designs' local params/profiles + placeholder usage, for share/unshare warnings. */
export const GET: RequestHandler = ({ params }) => {
	try {
		return json(getSiblingUsage(Number(params.id)));
	} catch (e) {
		throw error(404, (e as Error).message);
	}
};

type Body =
	| { action: 'share_param'; name: string; value: string; remove_sibling_overrides?: boolean }
	| { action: 'unshare_param'; name: string }
	| { action: 'share_profile'; profile_id: number; remove_sibling_same_name?: boolean }
	| { action: 'unshare_profile'; profile_id: number };

export const POST: RequestHandler = async ({ params, request }) => {
	const designId = Number(params.id);
	const body = (await request.json()) as Body;
	try {
		switch (body.action) {
			case 'share_param':
				if (!body.name?.trim()) throw error(400, 'Missing name');
				shareParam(designId, body.name.trim(), body.value ?? '', !!body.remove_sibling_overrides);
				return json({ ok: true });
			case 'unshare_param':
				unshareParam(designId, body.name);
				return json({ ok: true });
			case 'share_profile':
				return json({ ok: true, profile_id: shareProfile(designId, body.profile_id, !!body.remove_sibling_same_name) });
			case 'unshare_profile':
				return json({ ok: true, profile_id: unshareProfile(designId, body.profile_id) });
			default:
				throw error(400, 'Unknown action');
		}
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(409, (e as Error).message);
	}
};
