import type { CompareRunInfo } from './types';

/** A run belongs to a suite, to a standalone series, or to neither. */
export interface RunLineageGroup {
	/** Group heading; null for runs with no series/suite. */
	label: string | null;
	/** The suite (or standalone series) id this group came from; null for ungrouped runs. */
	sourceId: number | null;
	runs: CompareRunInfo[];
}

/**
 * Short badge text for a single run's lineage, or null when it has none.
 *
 * A suite names its series after the design (see suite-executor.ts), so the
 * series name adds nothing once the suite name is shown — prefer the suite.
 */
export function runLineageBadge(run: CompareRunInfo): string | null {
	if (run.suite_id) return run.suite_name || `Suite #${run.suite_id}`;
	if (run.series_id) return run.series_name || `Series #${run.series_id}`;
	return null;
}

/**
 * Group runs by suite (falling back to standalone series), preserving the
 * order in which each group is first seen. Ungrouped runs land in a single
 * trailing group with a null label.
 */
export function groupRunsByLineage(runs: CompareRunInfo[]): RunLineageGroup[] {
	const groups = new Map<string, RunLineageGroup>();
	for (const run of runs) {
		const key = run.suite_id ? `suite:${run.suite_id}` : run.series_id ? `series:${run.series_id}` : 'none';
		const existing = groups.get(key);
		if (existing) {
			existing.runs.push(run);
			continue;
		}
		const badge = runLineageBadge(run);
		groups.set(key, {
			label: key === 'none' ? null : key.startsWith('suite:') ? `Suite: ${badge}` : `Series: ${badge}`,
			sourceId: run.suite_id ?? run.series_id ?? null,
			runs: [run]
		});
	}
	const ordered = [...groups.values()];
	const labeled = ordered.filter((g) => g.label !== null);
	const unlabeled = ordered.filter((g) => g.label === null);

	// Suite names are free text and do repeat, which would leave two groups under
	// the same heading. Fall back to the id only for the names that actually clash.
	const labelCounts = new Map<string, number>();
	for (const group of labeled) {
		labelCounts.set(group.label!, (labelCounts.get(group.label!) ?? 0) + 1);
	}
	for (const group of labeled) {
		if ((labelCounts.get(group.label!) ?? 0) > 1 && group.sourceId !== null) {
			group.label = `${group.label} #${group.sourceId}`;
		}
	}

	// Keep the unlabeled bucket last so named suites read first. It only needs a
	// heading of its own when there is something labeled above it to contrast with.
	if (labeled.length > 0) {
		for (const group of unlabeled) group.label = 'Not in a suite';
	}
	return [...labeled, ...unlabeled];
}

/**
 * Short, clash-safe badge text per run id, for compact UI like run chips.
 * Runs with no series or suite are absent from the map. Shares
 * {@link groupRunsByLineage}'s duplicate-name handling, minus the group prefix.
 */
export function runLineageBadges(runs: CompareRunInfo[]): Map<number, string> {
	const badges = new Map<number, string>();
	for (const group of groupRunsByLineage(runs)) {
		if (group.sourceId === null || group.label === null) continue;
		const short = group.label.replace(/^(Suite|Series): /, '');
		for (const run of group.runs) badges.set(run.id, short);
	}
	return badges;
}
