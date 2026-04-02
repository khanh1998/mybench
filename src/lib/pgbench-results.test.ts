import { describe, expect, it } from 'vitest';
import {
	formatProcessedPgbenchScripts,
	parsePgbenchFinalOutput,
	parseProcessedPgbenchScripts
} from '$lib/pgbench-results';

const SAMPLE_OUTPUT = `pgbench (16.11, server 18.3)
transaction type: multiple scripts
scaling factor: 1
query mode: prepared
number of clients: 30
number of threads: 2
maximum number of tries: 1
duration: 60 s
number of transactions actually processed: 19646
number of failed transactions: 0 (0.000%)
latency average = 898.249 ms
latency stddev = 7394.088 ms
initial connection time = 465.506 ms
tps = 64.854015 (without initial connection time)
SQL script 1: /tmp/script-1.pgbench
 - weight: 10 (targets 10.0% of total)
 - 1993 transactions (10.1% of total, tps = 6.579154)
 - number of failed transactions: 0 (0.000%)
 - latency average = 85.066 ms
 - latency stddev = 278.990 ms
SQL script 2: /tmp/script-2.pgbench
 - weight: 25 (targets 25.0% of total)
 - 4916 transactions (25.0% of total, tps = 16.228359)
 - number of failed transactions: 0 (0.000%)
 - latency average = 325.612 ms
 - latency stddev = 2451.746 ms`;

describe('parsePgbenchFinalOutput', () => {
	it('extracts the overall summary before script blocks', () => {
		const parsed = parsePgbenchFinalOutput(SAMPLE_OUTPUT);
		expect(parsed.summary).toEqual({
			tps: 64.854015,
			latency_avg_ms: 898.249,
			latency_stddev_ms: 7394.088,
			transactions: 19646,
			failed_transactions: 0,
			transaction_type: 'multiple scripts',
			scaling_factor: 1,
			query_mode: 'prepared',
			number_of_clients: 30,
			number_of_threads: 2,
			maximum_tries: 1,
			duration_secs: 60,
			initial_connection_time_ms: 465.506
		});
	});

	it('extracts per-script metrics from SQL script blocks', () => {
		const parsed = parsePgbenchFinalOutput(SAMPLE_OUTPUT);
		expect(parsed.scripts).toHaveLength(2);
		expect(parsed.scripts[0]).toMatchObject({
			position: 0,
			weight: 10,
			transactions: 1993,
			tps: 6.579154,
			latency_avg_ms: 85.066,
			latency_stddev_ms: 278.99,
			failed_transactions: 0
		});
		expect(parsed.scripts[1]).toMatchObject({
			position: 1,
			weight: 25,
			transactions: 4916,
			tps: 16.228359
		});
	});

	it('does not overwrite overall metrics with the last script block', () => {
		const parsed = parsePgbenchFinalOutput(SAMPLE_OUTPUT);
		expect(parsed.summary?.latency_avg_ms).toBe(898.249);
		expect(parsed.summary?.latency_avg_ms).not.toBe(parsed.scripts[1].latency_avg_ms);
	});

	it('supports built-in scenario output with no script blocks', () => {
		const parsed = parsePgbenchFinalOutput(`pgbench (PostgreSQL) 15.3
transaction type: <builtin: TPC-B (sort of)>
scaling factor: 1
query mode: simple
number of clients: 30
number of threads: 2
duration: 120 s
number of transactions actually processed: 33498
number of failed transactions: 1 (0.003%)
latency average = 107.456 ms
latency stddev = 136.400000 ms
initial connection time = 254.567 ms
tps = 279.500000 (without initial connection time)`);

		expect(parsed.summary).toEqual({
			tps: 279.5,
			latency_avg_ms: 107.456,
			latency_stddev_ms: 136.4,
			transactions: 33498,
			failed_transactions: 1,
			transaction_type: '<builtin: TPC-B (sort of)>',
			scaling_factor: 1,
			query_mode: 'simple',
			number_of_clients: 30,
			number_of_threads: 2,
			maximum_tries: null,
			duration_secs: 120,
			initial_connection_time_ms: 254.567
		});
		expect(parsed.scripts).toEqual([]);
	});

	it('keeps optional metadata null when absent', () => {
		const parsed = parsePgbenchFinalOutput(`number of transactions actually processed: 33498
number of failed transactions: 1 (0.003%)
latency average = 107.456 ms
latency stddev = 136.400000 ms
tps = 279.500000 (without initial connection time)`);

		expect(parsed.summary).toEqual({
			tps: 279.5,
			latency_avg_ms: 107.456,
			latency_stddev_ms: 136.4,
			transactions: 33498,
			failed_transactions: 1,
			transaction_type: null,
			scaling_factor: null,
			query_mode: null,
			number_of_clients: null,
			number_of_threads: null,
			maximum_tries: null,
			duration_secs: null,
			initial_connection_time_ms: null
		});
	});
});

describe('processed pgbench script snapshots', () => {
	it('round-trips the compatibility processed_script format', () => {
		const processed = formatProcessedPgbenchScripts([
			{ name: 'main', weight: 10, script: 'SELECT 1;' },
			{ name: 'refunds', weight: 25, script: 'SELECT 2;' }
		]);

		expect(parseProcessedPgbenchScripts(processed)).toEqual([
			{ position: 0, name: 'main', weight: 10, script: 'SELECT 1;' },
			{ position: 1, name: 'refunds', weight: 25, script: 'SELECT 2;' }
		]);
	});
});
