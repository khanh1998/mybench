import { oauthDiscoveryNotSupported } from '$lib/server/mcp/oauth-discovery.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => oauthDiscoveryNotSupported();
