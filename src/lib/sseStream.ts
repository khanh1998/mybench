/**
 * POSTs to an SSE endpoint that emits `{ line }` events followed by a final
 * `{ done: true, ok, error? }` event, forwarding each line to `onLine`.
 * Resolves with the final `ok` flag (false if the stream ends without a `done` event).
 */
export async function sseStream(url: string, body: object, onLine: (line: string) => void): Promise<boolean> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const parts = buf.split('\n\n');
		buf = parts.pop() ?? '';
		for (const part of parts) {
			const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
			if (!dataLine) continue;
			const data = JSON.parse(dataLine.slice(6));
			if (data.line !== undefined) onLine(data.line);
			if (data.done) return data.ok as boolean;
		}
	}
	return false;
}
