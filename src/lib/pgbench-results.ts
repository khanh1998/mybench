export interface PgbenchStepSummary {
	tps: number | null;
	latency_avg_ms: number | null;
	latency_stddev_ms: number | null;
	transactions: number | null;
	failed_transactions: number | null;
	transaction_type?: string | null;
	scaling_factor?: number | null;
	query_mode?: string | null;
	number_of_clients?: number | null;
	number_of_threads?: number | null;
	maximum_tries?: number | null;
	duration_secs?: number | null;
	initial_connection_time_ms?: number | null;
}

export interface PgbenchScriptSnapshot {
	position: number;
	name: string;
	weight: number | null;
	script: string;
}

export interface PgbenchScriptResult extends PgbenchScriptSnapshot {
	tps: number | null;
	latency_avg_ms: number | null;
	latency_stddev_ms: number | null;
	transactions: number | null;
	failed_transactions: number | null;
}

export interface ParsedPgbenchFinalOutput {
	summary: PgbenchStepSummary | null;
	scripts: PgbenchScriptResult[];
}

function parseNumber(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseSummaryBlock(text: string): PgbenchStepSummary | null {
	const summary: PgbenchStepSummary = {
		tps: parseNumber(text.match(/tps\s*=\s*([\d.]+)/)?.[1]),
		latency_avg_ms: parseNumber(text.match(/latency average\s*=\s*([\d.]+)\s*ms/)?.[1]),
		latency_stddev_ms: parseNumber(text.match(/latency stddev\s*=\s*([\d.]+)\s*ms/)?.[1]),
		transactions: parseInteger(text.match(/number of transactions actually processed:\s*(\d+)/)?.[1]),
		failed_transactions: parseInteger(text.match(/number of failed transactions:\s*(\d+)/)?.[1]),
		transaction_type: text.match(/transaction type:\s*([^\r\n]+)/)?.[1]?.trim() ?? null,
		scaling_factor: parseInteger(text.match(/scaling factor:\s*(\d+)/)?.[1]),
		query_mode: text.match(/query mode:\s*([^\r\n]+)/)?.[1]?.trim() ?? null,
		number_of_clients: parseInteger(text.match(/number of clients:\s*(\d+)/)?.[1]),
		number_of_threads: parseInteger(text.match(/number of threads:\s*(\d+)/)?.[1]),
		maximum_tries: parseInteger(text.match(/maximum number of tries:\s*(\d+)/)?.[1]),
		duration_secs: parseInteger(text.match(/duration:\s*(\d+)\s*s/)?.[1]),
		initial_connection_time_ms: parseNumber(text.match(/initial connection time\s*=\s*([\d.]+)\s*ms/)?.[1])
	};

	if (Object.values(summary).every((value) => value === null)) return null;
	return summary;
}

export function parsePgbenchFinalOutput(stdout: string): ParsedPgbenchFinalOutput {
	if (!stdout.trim()) return { summary: null, scripts: [] };
	const normalized = stdout.replace(/\r\n/g, '\n');

	const firstScriptMatch = normalized.match(/^SQL script \d+:/m);
	const summaryText = firstScriptMatch ? normalized.slice(0, firstScriptMatch.index) : normalized;
	const summary = parseSummaryBlock(summaryText);

	const scripts: PgbenchScriptResult[] = [];
	const blockRegex = /^SQL script (\d+):[^\n]*\n((?: - .*(?:\n|$))+)/gm;
	let blockMatch: RegExpExecArray | null;

	while ((blockMatch = blockRegex.exec(normalized)) !== null) {
		const body = blockMatch[2];
		const position = Math.max(0, Number.parseInt(blockMatch[1], 10) - 1);
		scripts.push({
			position,
			name: `Script ${position + 1}`,
			weight: parseInteger(body.match(/-\s+weight:\s*(\d+)/)?.[1]),
			script: '',
			transactions: parseInteger(body.match(/-\s+(\d+)\s+transactions\b/)?.[1]),
			tps: parseNumber(body.match(/tps\s*=\s*([\d.]+)/)?.[1]),
			failed_transactions: parseInteger(body.match(/number of failed transactions:\s*(\d+)/)?.[1]),
			latency_avg_ms: parseNumber(body.match(/latency average\s*=\s*([\d.]+)\s*ms/)?.[1]),
			latency_stddev_ms: parseNumber(body.match(/latency stddev\s*=\s*([\d.]+)\s*ms/)?.[1])
		});
	}

	return { summary, scripts };
}

export function parseProcessedPgbenchScripts(processedScript: string): PgbenchScriptSnapshot[] {
	if (!processedScript.trim()) return [];

	const scripts: PgbenchScriptSnapshot[] = [];
	const regex = /^-- \[(.+?) @(\d+)\]\n([\s\S]*?)(?=^-- \[.+? @\d+\]\n|\s*$)/gm;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(processedScript)) !== null) {
		scripts.push({
			position: scripts.length,
			name: match[1],
			weight: parseInteger(match[2]),
			script: match[3].trim()
		});
	}

	return scripts;
}

export function formatProcessedPgbenchScripts(scripts: Array<Pick<PgbenchScriptSnapshot, 'name' | 'weight' | 'script'>>): string {
	return scripts.map((script) => `-- [${script.name} @${script.weight ?? 0}]\n${script.script}`).join('\n\n');
}
