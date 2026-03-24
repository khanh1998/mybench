import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Per-request transport that bridges a single Web Request/Response cycle
 * to the MCP SDK's Transport interface.
 *
 * Flow:
 *   1. McpServer.connect(transport)  → sets transport.onmessage
 *   2. transport.onmessage!(body)    → server processes the JSON-RPC request
 *   3. server calls transport.send() → we resolve the response promise
 *   4. await transport.response      → return to HTTP caller
 */
export class SvelteKitMcpTransport implements Transport {
	onmessage?: (message: JSONRPCMessage) => void;
	onerror?: (error: Error) => void;
	onclose?: () => void;

	private _resolve!: (msg: JSONRPCMessage) => void;
	readonly response: Promise<JSONRPCMessage> = new Promise((resolve) => {
		this._resolve = resolve;
	});

	async start(): Promise<void> {}
	async close(): Promise<void> {}

	async send(message: JSONRPCMessage): Promise<void> {
		this._resolve(message);
	}
}
