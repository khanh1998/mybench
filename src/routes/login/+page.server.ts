import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const password = data.get('password') as string;

		if (!password || password !== env.AUTH_SECRET) {
			return fail(401, { error: 'Invalid password' });
		}

		cookies.set('session', env.AUTH_SECRET, {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: url.protocol === 'https:',
			maxAge: 60 * 60 * 24 * 30 // 30 days
		});

		const next = url.searchParams.get('next') || '/';
		throw redirect(303, next);
	}
};
