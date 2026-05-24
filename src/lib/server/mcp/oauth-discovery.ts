import { json } from '@sveltejs/kit';

const BODY = {
	error: 'oauth_not_supported',
	error_description:
		'mybench does not expose an OAuth authorization server. Configure MCP clients to call POST /mcp with an Authorization: Bearer token.'
};

export function oauthDiscoveryNotSupported(): Response {
	return json(BODY, {
		status: 404,
		headers: {
			'cache-control': 'no-store'
		}
	});
}
