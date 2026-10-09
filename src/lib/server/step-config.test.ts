import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ default: () => { throw new Error('db not used in these tests'); } }));

import { buildStepConfigs, resolvePlanParams } from '$lib/server/step-config';

const plan = {
	params: [{ name: 'TABLE', value: 'items' }, { name: 'CLIENTS', value: '8' }],
	profiles: [{ name: 'large', values: [{ param_name: 'CLIENTS', value: '64' }] }],
	run_settings: { snapshot_interval_seconds: 30 },
	steps: [
		{ id: 1, type: 'sql', script: 'CREATE TABLE {{TABLE}} (id int);', no_transaction: true },
		{ id: 2, type: 'pgbench', pgbench_options: '-c {{CLIENTS}} -T 60', pgbench_scripts: [{ name: 'read', weight: 1, weight_expr: '{{CLIENTS}}' }] },
		{ id: 3, type: 'pg_stat' },
		{ id: 4, type: 'proc' },
		{ id: 5, type: 'perf', perf_stat_enabled: true, perf_record_enabled: false, perf_events: 'cycles', perf_stat_duration: '{{CLIENTS}}s', perf_freq: '' }
	],
	pg_stat_step: {
		interval_seconds: 0,
		snap_tables: [{ pg_view_name: 'pg_stat_database' }, { pg_view_name: 'pg_stat_io' }],
		pg_locks_enabled: true,
		pg_locks_interval_seconds: 5,
		reset_stats: true,
		reset_statements: false,
		pss_track_planning: false,
		collect_statements: true
	},
	proc_step: { groups: [], interval_seconds: 10, collect_runner: true }
};

describe('resolvePlanParams', () => {
	it('applies profile overrides on top of plan params', () => {
		expect(resolvePlanParams(plan, 'large')).toEqual([{ name: 'TABLE', value: 'items' }, { name: 'CLIENTS', value: '64' }]);
		expect(resolvePlanParams(plan, '')).toEqual(plan.params);
		expect(resolvePlanParams(plan, 'missing')).toEqual(plan.params);
	});
});

describe('buildStepConfigs', () => {
	const cfg = buildStepConfigs(plan, 'large');

	it('resolves params in sql scripts', () => {
		expect(cfg.get(1)).toEqual({ script: 'CREATE TABLE items (id int);', no_transaction: true });
	});

	it('resolves pgbench options and weight expressions', () => {
		expect(cfg.get(2)).toEqual({ options: '-c 64 -T 60', scripts: [{ name: 'read', weight: '64' }] });
	});

	it('takes pg_stat config from plan level, falling back to the snapshot interval', () => {
		expect(cfg.get(3)).toMatchObject({ interval_seconds: 30, tables: ['pg_stat_database', 'pg_stat_io'], collect_statements: true, pg_locks_enabled: true, reset_stats: true });
	});

	it('takes proc config from plan level; empty groups means all', () => {
		expect(cfg.get(4)).toEqual({ groups: ['(all)'], interval_seconds: 10, collect_runner: true });
	});

	it('keeps only set perf fields, without the perf_ prefix', () => {
		expect(cfg.get(5)).toEqual({ stat_enabled: true, events: 'cycles', stat_duration: '64s' });
	});
});
