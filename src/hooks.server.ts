import { recoverStaleRuns } from '$lib/server/run-manager';
import getDb from '$lib/server/db';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// Initialize DB and recover stale runs on startup
getDb();
recoverStaleRuns();

const PUBLIC_PATHS = ['/login', '/favicon.ico'];

export const handle = async ({ event, resolve }: { event: import('@sveltejs/kit').RequestEvent; resolve: (event: import('@sveltejs/kit').RequestEvent) => Promise<Response> }) => {
	const secret = env.AUTH_SECRET;

	// No secret set = dev mode, skip auth
	if (!secret) return resolve(event);

	const path = event.url.pathname;

	// Always allow login page
	if (PUBLIC_PATHS.some(p => path.startsWith(p))) return resolve(event);

	// Bearer token — for MCP agents and API calls
	const authHeader = event.request.headers.get('authorization');
	if (authHeader === `Bearer ${secret}`) return resolve(event);

	// Session cookie — for browser
	const sessionToken = event.cookies.get('session');
	if (sessionToken === secret) return resolve(event);

	// Browser request → redirect to login
	const acceptsHtml = event.request.headers.get('accept')?.includes('text/html');
	if (acceptsHtml) {
		throw redirect(303, `/login?next=${encodeURIComponent(path)}`);
	}

	// API / MCP request → 401
	return new Response(JSON.stringify({ error: 'Unauthorized' }), {
		status: 401,
		headers: { 'content-type': 'application/json' }
	});
};
