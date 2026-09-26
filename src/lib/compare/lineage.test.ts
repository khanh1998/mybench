import { describe, expect, it } from 'vitest';
import { groupRunsByLineage, runLineageBadge, runLineageBadges } from './lineage';
import type { CompareRunInfo } from './types';

function run(id: number, lineage: Partial<CompareRunInfo> = {}): CompareRunInfo {
	return {
		id,
		name: `run-${id}`,
		status: 'completed',
		tps: null,
		latency_avg_ms: null,
		latency_stddev_ms: null,
		transactions: null,
		profile_name: null,
		run_params: null,
		started_at: '2026-09-19 10:00:00',
		bench_started_at: null,
		post_started_at: null,
		finished_at: null,
		...lineage
	};
}

describe('run lineage badges', () => {
	it('prefers the suite name over the series name', () => {
		// A suite names its series after the design, so the series adds nothing.
		const badge = runLineageBadge(
			run(1, { series_id: 224, series_name: 'hash_id_32', suite_id: 63, suite_name: 'sync commit on' })
		);
		expect(badge).toBe('sync commit on');
	});

	it('falls back to the series name for a standalone series', () => {
		expect(runLineageBadge(run(1, { series_id: 12, series_name: 'ramp up' }))).toBe('ramp up');
	});

	it('has no badge for a one-off run', () => {
		expect(runLineageBadge(run(1))).toBeNull();
	});

	it('falls back to ids when names are empty', () => {
		expect(runLineageBadge(run(1, { suite_id: 63, suite_name: '' }))).toBe('Suite #63');
		expect(runLineageBadge(run(2, { series_id: 9, series_name: null }))).toBe('Series #9');
	});
});

describe('groupRunsByLineage', () => {
	it('groups runs by suite in first-seen order', () => {
		const groups = groupRunsByLineage([
			run(1142, { series_id: 224, suite_id: 63, suite_name: 'sync commit on' }),
			run(1138, { series_id: 220, suite_id: 62, suite_name: 'sync commit off (cache 1)' }),
			run(1137, { series_id: 220, suite_id: 62, suite_name: 'sync commit off (cache 1)' })
		]);

		expect(groups.map((g) => g.label)).toEqual([
			'Suite: sync commit on',
			'Suite: sync commit off (cache 1)'
		]);
		expect(groups[1].runs.map((r) => r.id)).toEqual([1138, 1137]);
	});

	it('appends the suite id only to labels that collide', () => {
		// Suite names are free text; two different suites really can share one.
		const groups = groupRunsByLineage([
			run(1132, { series_id: 214, suite_id: 61, suite_name: 'sync commit off' }),
			run(1089, { series_id: 193, suite_id: 55, suite_name: 'sync commit off' }),
			run(1142, { series_id: 224, suite_id: 63, suite_name: 'sync commit on' })
		]);

		expect(groups.map((g) => g.label)).toEqual([
			'Suite: sync commit off #61',
			'Suite: sync commit off #55',
			'Suite: sync commit on'
		]);
	});

	it('keeps ungrouped runs last and heads them only when suites are present', () => {
		const mixed = groupRunsByLineage([
			run(1145),
			run(1142, { series_id: 224, suite_id: 63, suite_name: 'sync commit on' })
		]);
		expect(mixed.map((g) => g.label)).toEqual(['Suite: sync commit on', 'Not in a suite']);

		const onlyLoose = groupRunsByLineage([run(1145), run(1144)]);
		expect(onlyLoose).toHaveLength(1);
		expect(onlyLoose[0].label).toBeNull();
		expect(onlyLoose[0].runs.map((r) => r.id)).toEqual([1145, 1144]);
	});

	it('separates a standalone series from a suite', () => {
		const groups = groupRunsByLineage([
			run(1142, { series_id: 224, suite_id: 63, suite_name: 'sync commit on' }),
			run(900, { series_id: 12, series_name: 'ramp up' })
		]);
		expect(groups.map((g) => g.label)).toEqual(['Suite: sync commit on', 'Series: ramp up']);
	});
});

describe('runLineageBadges', () => {
	it('maps run ids to clash-safe badges without the group prefix', () => {
		const badges = runLineageBadges([
			run(1132, { series_id: 214, suite_id: 61, suite_name: 'sync commit off' }),
			run(1089, { series_id: 193, suite_id: 55, suite_name: 'sync commit off' }),
			run(900, { series_id: 12, series_name: 'ramp up' }),
			run(1145)
		]);

		expect(badges.get(1132)).toBe('sync commit off #61');
		expect(badges.get(1089)).toBe('sync commit off #55');
		expect(badges.get(900)).toBe('ramp up');
		expect(badges.has(1145)).toBe(false);
	});
});
