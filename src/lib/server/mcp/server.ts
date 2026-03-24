import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

export function buildMcpServer(): McpServer {
	const server = new McpServer({
		name: 'mybench',
		version: '1.0.0'
	});
	registerTools(server);
	return server;
}
