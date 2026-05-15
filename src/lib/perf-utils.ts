export function parsePerfNumber(value: string | undefined): number | null {
	const clean = value?.trim().replaceAll(',', '') ?? '';
	if (!clean || clean.startsWith('<')) return null;
	const parsed = Number.parseFloat(clean);
	return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePerfRuntime(value: number | null | undefined): number | null {
	if (value === null || value === undefined || Number.isNaN(value)) return null;
	return value > 1_000_000 ? value / 1_000_000_000 : value;
}

export interface RawPerfFields {
	runtime_secs: number | null;
	percent_running: number | null;
	derived_value: number | null;
	derived_unit: string;
}

export function parseRawPerfEvent(rawError: string, eventName: string): RawPerfFields | null {
	for (const line of rawError.split('\n')) {
		const parts = line.trim().split('\t');
		if (parts.length < 3 || parts[2]?.trim() !== eventName) continue;
		let runtimeIdx = 3;
		if (parts[3] !== undefined && parsePerfNumber(parts[3].trim()) === null) runtimeIdx = 4;
		const runtimeRaw = parsePerfNumber(parts[runtimeIdx] ?? '');
		const percentRaw = parsePerfNumber((parts[runtimeIdx + 1] ?? '').replace('%', ''));
		const derivedValue = parsePerfNumber(parts[runtimeIdx + 2] ?? '');
		return {
			runtime_secs: runtimeRaw === null ? null : runtimeRaw / 1_000_000_000,
			percent_running: percentRaw,
			derived_value: derivedValue,
			derived_unit: derivedValue === null ? '' : parts.slice(runtimeIdx + 3).join(' ').trim()
		};
	}
	return null;
}

export interface PerfEventCore {
	event_name: string;
	counter_value: number | null;
	runtime_secs: number | null;
	percent_running: number | null;
	per_transaction: number | null;
	derived_value: number | null;
	derived_unit: string;
}

/** Apply corrections for the cgroup-column-shift bug and missing per_transaction. */
export function correctPerfEvent<T extends PerfEventCore>(
	event: T,
	rawError: string,
	totalTransactions?: number | null
): T {
	const raw = parseRawPerfEvent(rawError, event.event_name);
	return {
		...event,
		runtime_secs: raw?.runtime_secs ?? normalizePerfRuntime(event.runtime_secs),
		percent_running: raw?.percent_running ?? event.percent_running ?? null,
		derived_value: raw?.derived_value ?? event.derived_value ?? null,
		derived_unit: raw?.derived_unit || event.derived_unit || '',
		per_transaction:
			event.per_transaction ??
			(totalTransactions && event.counter_value !== null
				? event.counter_value / totalTransactions
				: null)
	};
}
