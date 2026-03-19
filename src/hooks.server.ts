import { recoverStaleRuns } from '$lib/server/run-manager';
import getDb from '$lib/server/db';

// Initialize DB and recover stale runs on startup
getDb();
recoverStaleRuns();

export const handle = async ({ event, resolve }: { event: import('@sveltejs/kit').RequestEvent; resolve: (event: import('@sveltejs/kit').RequestEvent) => Promise<Response> }) => {
	return resolve(event);
};
