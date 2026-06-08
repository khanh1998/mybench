/**
 * Normalise a timestamp string to a proper ISO 8601 UTC string.
 *
 * SQLite's datetime('now') returns "2024-01-15 09:30:00" — no T, no Z.
 * JavaScript's new Date().toISOString() returns "2024-01-15T09:30:05.123Z" — correct.
 * Both represent UTC; we just need to tell the Date constructor that for the old format.
 */
function normalise(ts: string): string {
	// Already has timezone info (Z or +offset) or the T separator → leave as-is
	if (ts.includes('T') || ts.includes('+') || ts.endsWith('Z')) return ts;
	// SQLite format "YYYY-MM-DD HH:MM:SS" — treat as UTC
	return ts.replace(' ', 'T') + 'Z';
}

/**
 * Format a timestamp as a short local date+time: "Jan 15, 09:30 AM"
 * Returns "—" for null/undefined/empty.
 */
export function fmtTs(ts: string | null | undefined): string {
	if (!ts) return '—';
	return new Date(normalise(ts)).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

/**
 * Format a timestamp as local time only: "09:30:05 AM"
 * Useful for step start/finish times within a run.
 * Returns "—" for null/undefined/empty.
 */
export function fmtTime(ts: string | null | undefined): string {
	if (!ts) return '—';
	return new Date(normalise(ts)).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
}

export function markdownCell(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'number') return Number.isFinite(value) ? String(+value.toFixed(4)) : '';
	return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function markdownTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
	return [
		`| ${headers.map(markdownCell).join(' | ')} |`,
		`| ${headers.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`)
	].join('\n');
}
