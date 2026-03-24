import { json } from '@sveltejs/kit';
import { buildMcpServer } from '$lib/server/mcp/server.js';
import { SvelteKitMcpTransport } from '$lib/server/mcp/transport.js';
import type { RequestHandler } from './$types';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as JSONRPCMessage;

	// Notifications have no `id` — server shouldn't respond (e.g. notifications/initialized)
	if (!('id' in body)) {
		const transport = new SvelteKitMcpTransport();
		const server = buildMcpServer();
		await server.connect(transport);
		transport.onmessage!(body);
		return new Response(null, { status: 202 });
	}

	const transport = new SvelteKitMcpTransport();
	const server = buildMcpServer();
	await server.connect(transport);
	transport.onmessage!(body);

	const response = await transport.response;
	return json(response);
};
