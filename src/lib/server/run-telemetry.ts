import type Database from 'better-sqlite3';

export type TelemetryPhase = 'pre' | 'bench' | 'post';
export type TelemetryValueKind = 'count' | 'bytes' | 'percent' | 'duration_ms' | 'tps' | 'text' | 'flag';
export type TelemetryStatus = 'ok' | 'no_data' | 'unsupported';

export interface TelemetryCard {
	key: string;
	label: string;
	kind: TelemetryValueKind;
	value: number | string | boolean | null;
	infoText?: string;
}

export interface TelemetryTableColumn {
	key: string;
	label: string;
	kind?: TelemetryValueKind;
}

export interface TelemetrySeriesPoint {
	t: number;
	v: number;
}

export interface TelemetrySeries {
	label: string;
	color: string;
	points: TelemetrySeriesPoint[];
}

export interface TelemetryMarker {
	t: number;
	label: string;
	color?: string;
}

export interface TelemetrySection {
	key: string;
	label: string;
	status: TelemetryStatus;
	reason?: string;
	summary: TelemetryCard[];
	chartTitle: string;
	chartSeries: TelemetrySeries[];
	tableTitle: string;
	tableColumns: TelemetryTableColumn[];
	tableRows: Record<string, unknown>[];
}

export interface RunTelemetry {
	runId: number;
	database: string;
	originTs: string;
	availablePhases: TelemetryPhase[];
	selectedPhases: TelemetryPhase[];
	markers: TelemetryMarker[];
	heroCards: TelemetryCard[];
	sections: TelemetrySection[];
}

interface RunMeta {
	id: number;
	design_id: number;
	database: string;
	started_at: string;
	bench_started_at: string | null;
	post_started_at: string | null;
}

interface SnapshotRow {
	_collected_at: string;
	_phase: TelemetryPhase;
	[key: string]: unknown;
}

const COLORS = ['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800'];
const ALL_PHASES: TelemetryPhase[] = ['pre', 'bench', 'post'];
const METRIC_INFO: Partial<Record<string, string>> = {
	transactions:
		'Commits plus rollbacks from pg_stat_database. This is the change between the first and last snapshot in the selected phases.',
	tps:
		'Database-side transactions per second, calculated as total transactions divided by elapsed time between the first and last pg_stat_database snapshots.',
	db_tps:
		'Database-side transactions per second, calculated as total transactions divided by elapsed time between the first and last pg_stat_database snapshots.',
	buffer_hit_ratio:
		'Share of block access served from shared buffers instead of disk: blks_hit / (blks_hit + blks_read). Higher is usually better.',
	temp_bytes:
		'Bytes written to temporary files during the selected phases. Higher values often mean sorts or hashes spilled to disk.',
	total_conflicts:
		'Total recovery conflicts reported by pg_stat_database_conflicts across all tracked conflict types.',
	lock_conflicts: 'Recovery conflicts caused by locks blocking standby queries.',
	snapshot_conflicts: 'Recovery conflicts caused by snapshots that would block cleanup or replay.',
	deadlock_conflicts: 'Recovery conflicts caused by deadlocks during recovery.',
	wal_bytes: 'Total WAL volume generated, calculated from the pg_stat_wal.wal_bytes delta.',
	wal_bytes_per_tx:
		'Average WAL volume per transaction: WAL bytes divided by total transactions. This helps compare write amplification between designs.',
	wal_per_tx:
		'Average WAL volume per transaction: WAL bytes divided by total transactions. This helps compare write amplification between designs.',
	fpi_ratio:
		'Share of WAL records that were full-page images: wal_fpi / wal_records. Higher values can mean more page rewrites after checkpoints.',
	wal_buffers_full: 'Number of times WAL insertion had to wait because WAL buffers filled up.',
	buffers_clean: 'Buffers written by the background writer outside of checkpoints.',
	maxwritten_clean:
		'Number of times the background writer stopped a cleaning cycle because it hit bgwriter_lru_maxpages.',
	buffers_alloc: 'Shared buffers allocated to new pages.',
	stats_reset:
		'Timestamp when PostgreSQL last reset this stats view. Older reset times mean the counters have been accumulating longer.',
	archived_count: 'Number of WAL segments successfully archived during the selected phases.',
	failed_count: 'Number of WAL segments that failed to archive during the selected phases.',
	last_archived_time: 'Timestamp of the most recent successful WAL archive seen in the selected snapshots.',
	last_failed_time: 'Timestamp of the most recent failed WAL archive attempt seen in the selected snapshots.',
	reads: 'Total read operations reported by pg_stat_io across the selected IO groups.',
	read_bytes: 'Total bytes read, summed from pg_stat_io.read_bytes across the selected phases.',
	writes: 'Total write operations reported by pg_stat_io across the selected IO groups.',
	write_bytes: 'Total bytes written, summed from pg_stat_io.write_bytes across the selected phases.',
	extend_bytes: 'Bytes written while extending relation files. This often reflects table or index growth.',
	evictions: 'Buffers evicted from cache by PostgreSQL across the selected IO groups.',
	fsyncs: 'Number of fsync calls reported by pg_stat_io.',
	total_writes:
		'Rows inserted, updated, or deleted across user tables. Calculated as n_tup_ins + n_tup_upd + n_tup_del deltas.',
	avg_seq_ratio:
		'Average share of scans that were sequential instead of index-backed across tracked user tables: seq_scan / (seq_scan + idx_scan).',
	avg_hot_ratio:
		'Average share of updates that qualified as HOT updates across tracked user tables: n_tup_hot_upd / n_tup_upd.',
	dead_tuple_growth: 'Net increase in dead tuples across user tables between the first and last snapshot.',
	total_index_scans: 'Total number of index scans across tracked user indexes.',
	tuples_read: 'Tuples returned from index entries before heap visibility checks, from idx_tup_read.',
	tuples_fetched: 'Heap tuples fetched through index scans, from idx_tup_fetch.',
	unused_indexes: 'Tracked indexes with zero scans during the selected phases.',
	heap_activity: 'Heap block activity for user tables, calculated as heap_blks_read + heap_blks_hit.',
	heap_hits: 'Heap blocks found in shared buffers for user tables.',
	heap_reads: 'Heap blocks read from disk for user tables.',
	heap_hit_ratio:
		'Average share of heap block access served from cache across tracked tables: heap_blks_hit / (heap_blks_hit + heap_blks_read).',
	toast_reads: 'TOAST blocks read from disk for user tables.',
	index_reads: 'Index blocks read from disk across tracked user indexes.',
	index_hit_ratio:
		'Average share of index block access served from cache across tracked indexes.',
	num_requested:
		'Checkpoints requested before the normal schedule, often because PostgreSQL hit WAL pressure.',
	requested_checkpoints:
		'Checkpoints requested before the normal schedule, often because PostgreSQL hit WAL pressure.',
	num_timed: 'Checkpoints started by the regular checkpoint_timeout schedule.',
	write_time:
		'Total time PostgreSQL spent writing buffers during checkpoints, shown as the delta of pg_stat_checkpointer.write_time.',
	sync_time:
		'Total time PostgreSQL spent syncing checkpoint files to disk, shown as the delta of pg_stat_checkpointer.sync_time.',
	deadlocks: 'Number of deadlocks reported by pg_stat_database during the selected phases.'
};

function parsePhases(phases?: string[]): TelemetryPhase[] {
	const unique = new Set<TelemetryPhase>();
	for (const phase of phases ?? ALL_PHASES) {
		if (phase === 'pre' || phase === 'bench' || phase === 'post') unique.add(phase);
	}
	return unique.size > 0 ? [...unique] : [...ALL_PHASES];
}

function tableExists(db: Database.Database, tableName: string): boolean {
	return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
}

function toNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string') {
		if (value.trim() === '') return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function toMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : null;
}

function safeRatio(numerator: number | null, denominator: number | null): number | null {
	if (numerator === null || denominator === null || denominator === 0) return null;
	return numerator / denominator;
}

function sum(values: Array<number | null>): number | null {
	const valid = values.filter((value): value is number => value !== null);
	if (valid.length === 0) return null;
	return valid.reduce((acc, value) => acc + value, 0);
}

function sortRows(rows: SnapshotRow[]): SnapshotRow[] {
	return [...rows].sort((a, b) => String(a._collected_at).localeCompare(String(b._collected_at)));
}

function delta(rows: SnapshotRow[], field: string): number | null {
	if (rows.length === 0) return null;
	const first = toNumber(rows[0][field]);
	const last = toNumber(rows[rows.length - 1][field]);
	if (first === null || last === null) return null;
	return last - first;
}

function latest(rows: SnapshotRow[], field: string): number | null {
	if (rows.length === 0) return null;
	return toNumber(rows[rows.length - 1][field]);
}

function latestText(rows: SnapshotRow[], field: string): string | null {
	if (rows.length === 0) return null;
	const value = rows[rows.length - 1][field];
	return value == null ? null : String(value);
}

function elapsedSeconds(rows: SnapshotRow[]): number | null {
	if (rows.length < 2) return null;
	const first = toMs(rows[0]._collected_at);
	const last = toMs(rows[rows.length - 1]._collected_at);
	if (first === null || last === null || last <= first) return null;
	return (last - first) / 1000;
}

function makeMetricRows(metrics: Array<{ metric: string; value: unknown; kind?: TelemetryValueKind }>): Record<string, unknown>[] {
	return metrics.map(({ metric, value, kind }) => ({ metric, value, value_kind: kind ?? 'text' }));
}

function metricCard(key: string, label: string, kind: TelemetryValueKind, value: number | string | boolean | null): TelemetryCard {
	return { key, label, kind, value, infoText: METRIC_INFO[key] };
}

function relPoint(row: SnapshotRow, runStartMs: number, value: number): TelemetrySeriesPoint | null {
	const collectedMs = toMs(row._collected_at);
	if (collectedMs === null || !Number.isFinite(value)) return null;
	return { t: collectedMs - runStartMs, v: value };
}

function buildCumulativeSeries(
	rows: SnapshotRow[],
	label: string,
	runStartMs: number,
	valueFn: (row: SnapshotRow) => number | null
): TelemetrySeries[] {
	if (rows.length === 0) return [];
	const baseline = valueFn(rows[0]) ?? 0;
	const points = rows
		.map((row) => {
			const current = valueFn(row);
			if (current === null) return null;
			return relPoint(row, runStartMs, current - baseline);
		})
		.filter((point): point is TelemetrySeriesPoint => point !== null);
	return points.length > 0 ? [{ label, color: COLORS[0], points }] : [];
}

function buildMetricSeries(
	rows: SnapshotRow[],
	runStartMs: number,
	metrics: Array<{ label: string; valueFn: (row: SnapshotRow) => number | null }>
): TelemetrySeries[] {
	return metrics
		.map((metric, index) => {
			if (rows.length === 0) return null;
			const baseline = metric.valueFn(rows[0]) ?? 0;
			const points = rows
				.map((row) => {
					const current = metric.valueFn(row);
					if (current === null) return null;
					return relPoint(row, runStartMs, current - baseline);
				})
				.filter((point): point is TelemetrySeriesPoint => point !== null);
			if (points.length === 0) return null;
			return { label: metric.label, color: COLORS[index % COLORS.length], points };
		})
		.filter((series): series is TelemetrySeries => series !== null);
}

function buildMultiSeries(
	entries: Array<{ key: string; label: string; rows: SnapshotRow[] }>,
	runStartMs: number,
	valueFn: (row: SnapshotRow) => number | null
): TelemetrySeries[] {
	return entries
		.map((entry, index) => {
			const sorted = sortRows(entry.rows);
			if (sorted.length === 0) return null;
			const baseline = valueFn(sorted[0]) ?? 0;
			const points = sorted
				.map((row) => {
					const current = valueFn(row);
					if (current === null) return null;
					return relPoint(row, runStartMs, current - baseline);
				})
				.filter((point): point is TelemetrySeriesPoint => point !== null);
			if (points.length === 0) return null;
			return { label: entry.label, color: COLORS[index % COLORS.length], points };
		})
		.filter((series): series is TelemetrySeries => series !== null);
}

function aggregateByTimestamp(
	rows: SnapshotRow[],
	runStartMs: number,
	valueFn: (bucket: SnapshotRow[]) => number | null,
	label: string
): TelemetrySeries[] {
	if (rows.length === 0) return [];
	const buckets = new Map<string, SnapshotRow[]>();
	for (const row of rows) {
		const key = String(row._collected_at);
		(buckets.get(key) ?? buckets.set(key, []).get(key)!).push(row);
	}
	const ordered = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	const baseline = valueFn(ordered[0][1]) ?? 0;
	const points = ordered
		.map(([collectedAt, bucket]) => {
			const value = valueFn(bucket);
			if (value === null) return null;
			return relPoint({ _collected_at: collectedAt, _phase: bucket[0]._phase }, runStartMs, value - baseline);
		})
		.filter((point): point is TelemetrySeriesPoint => point !== null);
	return points.length > 0 ? [{ label, color: COLORS[0], points }] : [];
}

function groupRows(rows: SnapshotRow[], keyFn: (row: SnapshotRow) => string): Map<string, SnapshotRow[]> {
	const grouped = new Map<string, SnapshotRow[]>();
	for (const row of rows) {
		const key = keyFn(row);
		const bucket = grouped.get(key) ?? [];
		bucket.push(row);
		grouped.set(key, bucket);
	}
	for (const [key, bucket] of grouped.entries()) grouped.set(key, sortRows(bucket));
	return grouped;
}

function topEntries<T>(items: T[], scoreFn: (item: T) => number | null, limit = 5): T[] {
	return [...items]
		.sort((a, b) => (scoreFn(b) ?? -Infinity) - (scoreFn(a) ?? -Infinity))
		.filter((item) => (scoreFn(item) ?? -Infinity) > -Infinity)
		.slice(0, limit);
}

function fetchRows(
	db: Database.Database,
	tableName: string,
	runId: number,
	phases: TelemetryPhase[],
	options: { databaseName?: string; datnameColumn?: string } = {}
): SnapshotRow[] {
	if (!tableExists(db, tableName)) return [];
	const params: unknown[] = [runId, ...phases];
	const clauses = [`_run_id = ?`, `_phase IN (${phases.map(() => '?').join(', ')})`];
	if (options.databaseName && options.datnameColumn) {
		clauses.push(`${options.datnameColumn} = ?`);
		params.push(options.databaseName);
	}
	return sortRows(
		db.prepare(`SELECT * FROM ${tableName} WHERE ${clauses.join(' AND ')} ORDER BY _collected_at`).all(...params) as SnapshotRow[]
	);
}

function detectAvailablePhases(db: Database.Database, runId: number, databaseName: string): TelemetryPhase[] {
	const phases = new Set<TelemetryPhase>();
	const phaseSources: Array<{ table: string; datnameColumn?: string }> = [
		{ table: 'snap_pg_stat_database', datnameColumn: 'datname' },
		{ table: 'snap_pg_stat_database_conflicts', datnameColumn: 'datname' },
		{ table: 'snap_pg_stat_wal' },
		{ table: 'snap_pg_stat_bgwriter' },
		{ table: 'snap_pg_stat_checkpointer' },
		{ table: 'snap_pg_stat_archiver' },
		{ table: 'snap_pg_stat_io' },
		{ table: 'snap_pg_stat_user_tables' },
		{ table: 'snap_pg_stat_user_indexes' },
		{ table: 'snap_pg_statio_user_tables' },
		{ table: 'snap_pg_statio_user_indexes' }
	];

	for (const source of phaseSources) {
		if (!tableExists(db, source.table)) continue;
		const params: unknown[] = [runId];
		const clauses = ['_run_id = ?'];
		if (source.datnameColumn) {
			clauses.push(`${source.datnameColumn} = ?`);
			params.push(databaseName);
		}
		const rows = db.prepare(`SELECT DISTINCT _phase FROM ${source.table} WHERE ${clauses.join(' AND ')}`).all(...params) as { _phase: TelemetryPhase }[];
		for (const row of rows) {
			if (row._phase === 'pre' || row._phase === 'bench' || row._phase === 'post') phases.add(row._phase);
		}
	}

	return phases.size > 0 ? ALL_PHASES.filter((phase) => phases.has(phase)) : [...ALL_PHASES];
}

function buildDatabaseSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	const txCommit = delta(rows, 'xact_commit');
	const txRollback = delta(rows, 'xact_rollback');
	const totalTransactions = sum([txCommit, txRollback]);
	const hitRatio = safeRatio(delta(rows, 'blks_hit'), sum([delta(rows, 'blks_hit'), delta(rows, 'blks_read')]));
	const tempBytes = delta(rows, 'temp_bytes');
	const deadlocks = delta(rows, 'deadlocks');
	const tps = safeRatio(totalTransactions, elapsedSeconds(rows));

	if (rows.length === 0) {
		return {
			key: 'database',
			label: 'Database',
			status: 'no_data',
			reason: 'No pg_stat_database snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Transactions',
			chartSeries: [],
			tableTitle: 'Database metrics',
			tableColumns: [],
			tableRows: []
		};
	}

	return {
		key: 'database',
		label: 'Database',
		status: 'ok',
		summary: [
			metricCard('transactions', 'Transactions', 'count', totalTransactions),
			metricCard('tps', 'DB-stat TPS', 'tps', tps),
			metricCard('buffer_hit_ratio', 'Buffer Hit Ratio', 'percent', hitRatio),
			metricCard('temp_bytes', 'Temp Bytes', 'bytes', tempBytes)
		],
		chartTitle: 'Transactions over time',
		chartSeries: buildCumulativeSeries(rows, 'transactions', runStartMs, (row) =>
			sum([toNumber(row.xact_commit), toNumber(row.xact_rollback)])
		),
		tableTitle: 'Database metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value', kind: 'count' }
		],
		tableRows: makeMetricRows([
			{ metric: 'Transactions', value: totalTransactions, kind: 'count' },
			{ metric: 'Commits', value: txCommit, kind: 'count' },
			{ metric: 'Rollbacks', value: txRollback, kind: 'count' },
			{ metric: 'DB-stat TPS', value: tps, kind: 'tps' },
			{ metric: 'Buffer hit ratio', value: hitRatio, kind: 'percent' },
			{ metric: 'Blocks read', value: delta(rows, 'blks_read'), kind: 'count' },
			{ metric: 'Blocks hit', value: delta(rows, 'blks_hit'), kind: 'count' },
			{ metric: 'Rows inserted', value: delta(rows, 'tup_inserted'), kind: 'count' },
			{ metric: 'Rows updated', value: delta(rows, 'tup_updated'), kind: 'count' },
			{ metric: 'Rows deleted', value: delta(rows, 'tup_deleted'), kind: 'count' },
			{ metric: 'Temp bytes', value: tempBytes, kind: 'bytes' },
			{ metric: 'Deadlocks', value: deadlocks, kind: 'count' },
			{ metric: 'Block read time (ms)', value: delta(rows, 'blk_read_time'), kind: 'duration_ms' },
			{ metric: 'Block write time (ms)', value: delta(rows, 'blk_write_time'), kind: 'duration_ms' }
		])
	};
}

function buildDatabaseConflictsSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	const lock = delta(rows, 'confl_lock');
	const snapshot = delta(rows, 'confl_snapshot');
	const deadlock = delta(rows, 'confl_deadlock');
	const total = sum([lock, snapshot, deadlock, delta(rows, 'confl_tablespace'), delta(rows, 'confl_bufferpin'), delta(rows, 'confl_active_logicalslot')]);

	if (rows.length === 0) {
		return {
			key: 'database_conflicts',
			label: 'Database Conflicts',
			status: 'no_data',
			reason: 'No pg_stat_database_conflicts snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Conflict types',
			chartSeries: [],
			tableTitle: 'Conflict metrics',
			tableColumns: [],
			tableRows: []
		};
	}

	return {
		key: 'database_conflicts',
		label: 'Database Conflicts',
		status: 'ok',
		summary: [
			metricCard('total_conflicts', 'Total Conflicts', 'count', total),
			metricCard('lock_conflicts', 'Lock Conflicts', 'count', lock),
			metricCard('snapshot_conflicts', 'Snapshot Conflicts', 'count', snapshot),
			metricCard('deadlock_conflicts', 'Deadlock Conflicts', 'count', deadlock)
		],
		chartTitle: 'Conflict types over time',
		chartSeries: buildMetricSeries(rows, runStartMs, [
			{ label: 'lock', valueFn: (row) => toNumber(row.confl_lock) },
			{ label: 'snapshot', valueFn: (row) => toNumber(row.confl_snapshot) },
			{ label: 'deadlock', valueFn: (row) => toNumber(row.confl_deadlock) }
		]),
		tableTitle: 'Conflict metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value', kind: 'count' }
		],
		tableRows: makeMetricRows([
			{ metric: 'Total conflicts', value: total, kind: 'count' },
			{ metric: 'Lock conflicts', value: lock, kind: 'count' },
			{ metric: 'Snapshot conflicts', value: snapshot, kind: 'count' },
			{ metric: 'Deadlock conflicts', value: deadlock, kind: 'count' },
			{ metric: 'Tablespace conflicts', value: delta(rows, 'confl_tablespace'), kind: 'count' },
			{ metric: 'Buffer pin conflicts', value: delta(rows, 'confl_bufferpin'), kind: 'count' },
			{ metric: 'Logical slot conflicts', value: delta(rows, 'confl_active_logicalslot'), kind: 'count' }
		])
	};
}

function buildWalSection(rows: SnapshotRow[], runStartMs: number, transactions: number | null): TelemetrySection {
	const walBytes = delta(rows, 'wal_bytes');
	const walRecords = delta(rows, 'wal_records');
	const walFpi = delta(rows, 'wal_fpi');
	const walBuffersFull = delta(rows, 'wal_buffers_full');

	if (rows.length === 0) {
		return {
			key: 'wal',
			label: 'WAL',
			status: 'no_data',
			reason: 'No pg_stat_wal snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'WAL bytes',
			chartSeries: [],
			tableTitle: 'WAL metrics',
			tableColumns: [],
			tableRows: []
		};
	}

	return {
		key: 'wal',
		label: 'WAL',
		status: 'ok',
		summary: [
			metricCard('wal_bytes', 'WAL Bytes', 'bytes', walBytes),
			metricCard('wal_bytes_per_tx', 'WAL / Tx', 'bytes', safeRatio(walBytes, transactions)),
			metricCard('fpi_ratio', 'FPI Ratio', 'percent', safeRatio(walFpi, walRecords)),
			metricCard('wal_buffers_full', 'WAL Buffers Full', 'count', walBuffersFull)
		],
		chartTitle: 'WAL bytes over time',
		chartSeries: buildCumulativeSeries(rows, 'wal_bytes', runStartMs, (row) => toNumber(row.wal_bytes)),
		tableTitle: 'WAL metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value' }
		],
		tableRows: makeMetricRows([
			{ metric: 'WAL bytes', value: walBytes, kind: 'bytes' },
			{ metric: 'WAL records', value: walRecords, kind: 'count' },
			{ metric: 'Full page images', value: walFpi, kind: 'count' },
			{ metric: 'FPI ratio', value: safeRatio(walFpi, walRecords), kind: 'percent' },
			{ metric: 'WAL buffers full', value: walBuffersFull, kind: 'count' }
		])
	};
}

function buildBgwriterSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	const buffersClean = delta(rows, 'buffers_clean');
	const maxwrittenClean = delta(rows, 'maxwritten_clean');
	const buffersAlloc = delta(rows, 'buffers_alloc');

	if (rows.length === 0) {
		return {
			key: 'bgwriter',
			label: 'BGWriter',
			status: 'no_data',
			reason: 'No pg_stat_bgwriter snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Background writer buffers',
			chartSeries: [],
			tableTitle: 'BGWriter metrics',
			tableColumns: [],
			tableRows: []
		};
	}

	return {
		key: 'bgwriter',
		label: 'BGWriter',
		status: 'ok',
		summary: [
			metricCard('buffers_clean', 'Buffers Clean', 'count', buffersClean),
			metricCard('maxwritten_clean', 'Maxwritten Clean', 'count', maxwrittenClean),
			metricCard('buffers_alloc', 'Buffers Alloc', 'count', buffersAlloc),
			metricCard('stats_reset', 'Stats Reset', 'text', latestText(rows, 'stats_reset'))
		],
		chartTitle: 'Background writer activity over time',
		chartSeries: buildMetricSeries(rows, runStartMs, [
			{ label: 'buffers clean', valueFn: (row) => toNumber(row.buffers_clean) },
			{ label: 'buffers alloc', valueFn: (row) => toNumber(row.buffers_alloc) },
			{ label: 'maxwritten clean', valueFn: (row) => toNumber(row.maxwritten_clean) }
		]),
		tableTitle: 'BGWriter metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value' }
		],
		tableRows: makeMetricRows([
			{ metric: 'Buffers clean', value: buffersClean, kind: 'count' },
			{ metric: 'Maxwritten clean', value: maxwrittenClean, kind: 'count' },
			{ metric: 'Buffers alloc', value: buffersAlloc, kind: 'count' },
			{ metric: 'Stats reset', value: latestText(rows, 'stats_reset'), kind: 'text' }
		])
	};
}

function buildArchiverSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	if (rows.length === 0) {
		return {
			key: 'archiver',
			label: 'Archiver',
			status: 'no_data',
			reason: 'No pg_stat_archiver snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Archived WAL segments',
			chartSeries: [],
			tableTitle: 'Archiver metrics',
			tableColumns: [],
			tableRows: []
		};
	}

	return {
		key: 'archiver',
		label: 'Archiver',
		status: 'ok',
		summary: [
			metricCard('archived_count', 'Archived Segments', 'count', delta(rows, 'archived_count')),
			metricCard('failed_count', 'Archive Failures', 'count', delta(rows, 'failed_count')),
			metricCard('last_archived_time', 'Last Archived At', 'text', latestText(rows, 'last_archived_time')),
			metricCard('last_failed_time', 'Last Failure At', 'text', latestText(rows, 'last_failed_time'))
		],
		chartTitle: 'Archived WAL segments over time',
		chartSeries: buildCumulativeSeries(rows, 'archived', runStartMs, (row) => toNumber(row.archived_count)),
		tableTitle: 'Archiver metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value' }
		],
		tableRows: makeMetricRows([
			{ metric: 'Archived segments', value: delta(rows, 'archived_count'), kind: 'count' },
			{ metric: 'Archive failures', value: delta(rows, 'failed_count'), kind: 'count' },
			{ metric: 'Last archived WAL', value: latestText(rows, 'last_archived_wal'), kind: 'text' },
			{ metric: 'Last archived at', value: latestText(rows, 'last_archived_time'), kind: 'text' },
			{ metric: 'Last failed WAL', value: latestText(rows, 'last_failed_wal'), kind: 'text' },
			{ metric: 'Last failure at', value: latestText(rows, 'last_failed_time'), kind: 'text' }
		])
	};
}

function buildIoSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	if (rows.length === 0) {
		return {
			key: 'io',
			label: 'IO',
			status: 'no_data',
			reason: 'No pg_stat_io snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Top IO groups',
			chartSeries: [],
			tableTitle: 'IO groups',
			tableColumns: [],
			tableRows: []
		};
	}

	const grouped = groupRows(rows, (row) => `${row.backend_type ?? 'unknown'}|${row.object ?? 'unknown'}|${row.context ?? 'unknown'}`);
	const entries = [...grouped.entries()].map(([key, bucket]) => {
		const [backend_type, object, context] = key.split('|');
		const readBytes = delta(bucket, 'read_bytes');
		const writeBytes = delta(bucket, 'write_bytes');
		const extendBytes = delta(bucket, 'extend_bytes');
		const totalBytes = sum([readBytes, writeBytes, extendBytes]);
		return {
			key,
			label: `${backend_type}/${object}/${context}`,
			backend_type,
			object,
			context,
			rows: bucket,
			totalBytes,
			reads: delta(bucket, 'reads'),
			readBytes,
			writes: delta(bucket, 'writes'),
			writeBytes,
			extends: delta(bucket, 'extends'),
			extendBytes,
			hits: delta(bucket, 'hits'),
			evictions: delta(bucket, 'evictions'),
			fsyncs: delta(bucket, 'fsyncs')
		};
	});
	const topGroups = topEntries(entries, (entry) => entry.totalBytes ?? sum([entry.reads, entry.writes]));

	return {
		key: 'io',
		label: 'IO',
		status: 'ok',
		summary: [
			metricCard('reads', 'Reads', 'count', sum(entries.map((entry) => entry.reads))),
			metricCard('read_bytes', 'Read Bytes', 'bytes', sum(entries.map((entry) => entry.readBytes))),
			metricCard('writes', 'Writes', 'count', sum(entries.map((entry) => entry.writes))),
			metricCard('write_bytes', 'Write Bytes', 'bytes', sum(entries.map((entry) => entry.writeBytes))),
			metricCard('extend_bytes', 'Extend Bytes', 'bytes', sum(entries.map((entry) => entry.extendBytes))),
			metricCard('evictions', 'Evictions', 'count', sum(entries.map((entry) => entry.evictions))),
			metricCard('fsyncs', 'FSyncs', 'count', sum(entries.map((entry) => entry.fsyncs)))
		],
		chartTitle: 'Top IO groups by bytes over time',
		chartSeries: buildMultiSeries(topGroups.map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows })), runStartMs, (row) =>
			sum([toNumber(row.read_bytes), toNumber(row.write_bytes), toNumber(row.extend_bytes)])
		),
		tableTitle: 'Top IO groups',
		tableColumns: [
			{ key: 'group', label: 'Group', kind: 'text' },
			{ key: 'reads', label: 'Reads', kind: 'count' },
			{ key: 'read_bytes', label: 'Read Bytes', kind: 'bytes' },
			{ key: 'writes', label: 'Writes', kind: 'count' },
			{ key: 'write_bytes', label: 'Write Bytes', kind: 'bytes' },
			{ key: 'extends', label: 'Extends', kind: 'count' },
			{ key: 'extend_bytes', label: 'Extend Bytes', kind: 'bytes' },
			{ key: 'hits', label: 'Hits', kind: 'count' },
			{ key: 'evictions', label: 'Evictions', kind: 'count' },
			{ key: 'fsyncs', label: 'FSyncs', kind: 'count' }
		],
		tableRows: topGroups.map((entry) => ({
			group: entry.label,
			reads: entry.reads,
			read_bytes: entry.readBytes,
			writes: entry.writes,
			write_bytes: entry.writeBytes,
			extends: entry.extends,
			extend_bytes: entry.extendBytes,
			hits: entry.hits,
			evictions: entry.evictions,
			fsyncs: entry.fsyncs
		}))
	};
}

function buildUserTablesSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	if (rows.length === 0) {
		return {
			key: 'user_tables',
			label: 'User Tables',
			status: 'no_data',
			reason: 'No pg_stat_user_tables snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Top tables by writes',
			chartSeries: [],
			tableTitle: 'Top tables',
			tableColumns: [],
			tableRows: []
		};
	}

	const grouped = groupRows(rows, (row) => String(row.relname ?? 'unknown'));
	const entries = [...grouped.entries()].map(([relname, bucket]) => {
		const writes = sum([delta(bucket, 'n_tup_ins'), delta(bucket, 'n_tup_upd'), delta(bucket, 'n_tup_del')]);
		const seqScans = delta(bucket, 'seq_scan');
		const idxScans = delta(bucket, 'idx_scan');
		const hotUpdates = delta(bucket, 'n_tup_hot_upd');
		const updates = delta(bucket, 'n_tup_upd');
		return {
			key: relname,
			label: relname,
			rows: bucket,
			writes,
			seqScanRatio: safeRatio(seqScans, sum([seqScans, idxScans])),
			hotRatio: safeRatio(hotUpdates, updates),
			deadTupleGrowth: (() => {
				const first = toNumber(bucket[0].n_dead_tup);
				const last = toNumber(bucket[bucket.length - 1].n_dead_tup);
				if (first === null || last === null) return null;
				return last - first;
			})()
		};
	});
	const topTables = topEntries(entries, (entry) => entry.writes);

	return {
		key: 'user_tables',
		label: 'User Tables',
		status: 'ok',
		summary: [
			metricCard('total_writes', 'Total Writes', 'count', sum(entries.map((entry) => entry.writes))),
			metricCard('avg_seq_ratio', 'Avg Seq Scan Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.seqScanRatio)), entries.length || null)),
			metricCard('avg_hot_ratio', 'Avg HOT Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.hotRatio)), entries.length || null)),
			metricCard('dead_tuple_growth', 'Dead Tuple Growth', 'count', sum(entries.map((entry) => entry.deadTupleGrowth)))
		],
		chartTitle: 'Top tables by writes over time',
		chartSeries: buildMultiSeries(topTables.map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows })), runStartMs, (row) =>
			sum([toNumber(row.n_tup_ins), toNumber(row.n_tup_upd), toNumber(row.n_tup_del)])
		),
		tableTitle: 'Top tables by writes',
		tableColumns: [
			{ key: 'table', label: 'Table', kind: 'text' },
			{ key: 'writes', label: 'Writes', kind: 'count' },
			{ key: 'seq_scan_ratio', label: 'Seq Scan Ratio', kind: 'percent' },
			{ key: 'hot_update_ratio', label: 'HOT Update Ratio', kind: 'percent' },
			{ key: 'dead_tuple_growth', label: 'Dead Tuple Growth', kind: 'count' }
		],
		tableRows: topTables.map((entry) => ({
			table: entry.label,
			writes: entry.writes,
			seq_scan_ratio: entry.seqScanRatio,
			hot_update_ratio: entry.hotRatio,
			dead_tuple_growth: entry.deadTupleGrowth
		}))
	};
}

function buildUserIndexesSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	if (rows.length === 0) {
		return {
			key: 'user_indexes',
			label: 'User Indexes',
			status: 'no_data',
			reason: 'No pg_stat_user_indexes snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Top indexes by scans',
			chartSeries: [],
			tableTitle: 'Top indexes',
			tableColumns: [],
			tableRows: []
		};
	}

	const grouped = groupRows(rows, (row) => `${row.relname ?? 'unknown'}|${row.indexrelname ?? 'unknown'}`);
	const entries = [...grouped.entries()].map(([key, bucket]) => {
		const [relname, indexrelname] = key.split('|');
		const idxScans = delta(bucket, 'idx_scan');
		const idxRead = delta(bucket, 'idx_tup_read');
		const idxFetch = delta(bucket, 'idx_tup_fetch');
		return {
			key,
			label: `${relname}.${indexrelname}`,
			rows: bucket,
			idxScans,
			idxRead,
			idxFetch,
			selectivity: safeRatio(idxFetch, idxRead),
			unused: (idxScans ?? 0) === 0
		};
	});
	const topIndexes = topEntries(entries, (entry) => entry.idxScans);

	return {
		key: 'user_indexes',
		label: 'User Indexes',
		status: 'ok',
		summary: [
			metricCard('total_index_scans', 'Index Scans', 'count', sum(entries.map((entry) => entry.idxScans))),
			metricCard('tuples_read', 'Tuples Read', 'count', sum(entries.map((entry) => entry.idxRead))),
			metricCard('tuples_fetched', 'Tuples Fetched', 'count', sum(entries.map((entry) => entry.idxFetch))),
			metricCard('unused_indexes', 'Unused Indexes', 'count', entries.filter((entry) => entry.unused).length)
		],
		chartTitle: 'Top indexes by scans over time',
		chartSeries: buildMultiSeries(topIndexes.map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows })), runStartMs, (row) => toNumber(row.idx_scan)),
		tableTitle: 'Top indexes by scans',
		tableColumns: [
			{ key: 'index', label: 'Index', kind: 'text' },
			{ key: 'idx_scans', label: 'Idx Scans', kind: 'count' },
			{ key: 'idx_tup_read', label: 'Tuples Read', kind: 'count' },
			{ key: 'idx_tup_fetch', label: 'Tuples Fetch', kind: 'count' },
			{ key: 'selectivity', label: 'Selectivity', kind: 'percent' },
			{ key: 'unused', label: 'Unused', kind: 'flag' }
		],
		tableRows: topIndexes.map((entry) => ({
			index: entry.label,
			idx_scans: entry.idxScans,
			idx_tup_read: entry.idxRead,
			idx_tup_fetch: entry.idxFetch,
			selectivity: entry.selectivity,
			unused: entry.unused
		}))
	};
}

function buildStatioUserTablesSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	if (rows.length === 0) {
		return {
			key: 'statio_user_tables',
			label: 'Statio User Tables',
			status: 'no_data',
			reason: 'No pg_statio_user_tables snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Top tables by heap activity',
			chartSeries: [],
			tableTitle: 'Top tables',
			tableColumns: [],
			tableRows: []
		};
	}

	const grouped = groupRows(rows, (row) => String(row.relname ?? 'unknown'));
	const entries = [...grouped.entries()].map(([relname, bucket]) => {
		const heapReads = delta(bucket, 'heap_blks_read');
		const heapHits = delta(bucket, 'heap_blks_hit');
		const heapActivity = sum([heapReads, heapHits]);
		return {
			key: relname,
			label: relname,
			rows: bucket,
			heapActivity,
			heapReads,
			heapHits,
			heapHitRatio: safeRatio(heapHits, sum([heapHits, heapReads])),
			toasts: delta(bucket, 'toast_blks_read')
		};
	});
	const topTables = topEntries(entries, (entry) => entry.heapActivity);

	return {
		key: 'statio_user_tables',
		label: 'Statio User Tables',
		status: 'ok',
		summary: [
			metricCard('heap_activity', 'Heap Activity', 'count', sum(entries.map((entry) => entry.heapActivity))),
			metricCard('heap_hits', 'Heap Hits', 'count', sum(entries.map((entry) => entry.heapHits))),
			metricCard('heap_reads', 'Heap Reads', 'count', sum(entries.map((entry) => entry.heapReads))),
			metricCard('heap_hit_ratio', 'Heap Hit Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.heapHitRatio)), entries.length || null)),
			metricCard('toast_reads', 'TOAST Reads', 'count', sum(entries.map((entry) => entry.toasts)))
		],
		chartTitle: 'Top tables by heap activity over time',
		chartSeries: buildMultiSeries(topTables.map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows })), runStartMs, (row) =>
			sum([toNumber(row.heap_blks_read), toNumber(row.heap_blks_hit)])
		),
		tableTitle: 'Top tables by heap activity',
		tableColumns: [
			{ key: 'table', label: 'Table', kind: 'text' },
			{ key: 'heap_activity', label: 'Heap Activity', kind: 'count' },
			{ key: 'heap_hits', label: 'Heap Hits', kind: 'count' },
			{ key: 'heap_reads', label: 'Heap Reads', kind: 'count' },
			{ key: 'heap_hit_ratio', label: 'Heap Hit Ratio', kind: 'percent' },
			{ key: 'toast_reads', label: 'TOAST Reads', kind: 'count' }
		],
		tableRows: topTables.map((entry) => ({
			table: entry.label,
			heap_activity: entry.heapActivity,
			heap_hits: entry.heapHits,
			heap_reads: entry.heapReads,
			heap_hit_ratio: entry.heapHitRatio,
			toast_reads: entry.toasts
		}))
	};
}

function buildStatioUserIndexesSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	if (rows.length === 0) {
		return {
			key: 'statio_user_indexes',
			label: 'Statio User Indexes',
			status: 'no_data',
			reason: 'No pg_statio_user_indexes snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Top indexes by block reads',
			chartSeries: [],
			tableTitle: 'Top indexes',
			tableColumns: [],
			tableRows: []
		};
	}

	const grouped = groupRows(rows, (row) => `${row.relname ?? 'unknown'}|${row.indexrelname ?? 'unknown'}`);
	const entries = [...grouped.entries()].map(([key, bucket]) => {
		const [relname, indexrelname] = key.split('|');
		const idxReads = delta(bucket, 'idx_blks_read');
		const idxHits = delta(bucket, 'idx_blks_hit');
		return {
			key,
			label: `${relname}.${indexrelname}`,
			rows: bucket,
			idxReads,
			idxHitRatio: safeRatio(idxHits, sum([idxHits, idxReads]))
		};
	});
	const topIndexes = topEntries(entries, (entry) => entry.idxReads);

	return {
		key: 'statio_user_indexes',
		label: 'Statio User Indexes',
		status: 'ok',
		summary: [
			metricCard('index_reads', 'Index Block Reads', 'count', sum(entries.map((entry) => entry.idxReads))),
			metricCard('index_hit_ratio', 'Index Hit Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.idxHitRatio)), entries.length || null))
		],
		chartTitle: 'Top indexes by block reads over time',
		chartSeries: buildMultiSeries(topIndexes.map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows })), runStartMs, (row) => toNumber(row.idx_blks_read)),
		tableTitle: 'Top indexes by block reads',
		tableColumns: [
			{ key: 'index', label: 'Index', kind: 'text' },
			{ key: 'idx_blks_read', label: 'Idx Blocks Read', kind: 'count' },
			{ key: 'idx_hit_ratio', label: 'Idx Hit Ratio', kind: 'percent' }
		],
		tableRows: topIndexes.map((entry) => ({
			index: entry.label,
			idx_blks_read: entry.idxReads,
			idx_hit_ratio: entry.idxHitRatio
		}))
	};
}

function buildCheckpointerSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	const numTimed = delta(rows, 'num_timed');
	const numRequested = delta(rows, 'num_requested');
	const writeTime = delta(rows, 'write_time');
	const syncTime = delta(rows, 'sync_time');

	if (rows.length === 0) {
		return {
			key: 'checkpointer',
			label: 'Checkpointer',
			status: 'no_data',
			reason: 'No pg_stat_checkpointer snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Checkpoint activity',
			chartSeries: [],
			tableTitle: 'Checkpointer metrics',
			tableColumns: [],
			tableRows: []
		};
	}

	return {
		key: 'checkpointer',
		label: 'Checkpointer',
		status: 'ok',
		summary: [
			metricCard('num_requested', 'Requested Checkpoints', 'count', numRequested),
			metricCard('num_timed', 'Timed Checkpoints', 'count', numTimed),
			metricCard('write_time', 'Write Time', 'duration_ms', writeTime),
			metricCard('sync_time', 'Sync Time', 'duration_ms', syncTime)
		],
		chartTitle: 'Checkpoint activity over time',
		chartSeries: buildMetricSeries(rows, runStartMs, [
			{ label: 'requested', valueFn: (row) => toNumber(row.num_requested) },
			{ label: 'timed', valueFn: (row) => toNumber(row.num_timed) }
		]),
		tableTitle: 'Checkpointer metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value' }
		],
		tableRows: makeMetricRows([
			{ metric: 'Requested checkpoints', value: numRequested, kind: 'count' },
			{ metric: 'Timed checkpoints', value: numTimed, kind: 'count' },
			{ metric: 'Timed restartpoints', value: delta(rows, 'restartpoints_timed'), kind: 'count' },
			{ metric: 'Requested restartpoints', value: delta(rows, 'restartpoints_req'), kind: 'count' },
			{ metric: 'Restartpoints done', value: delta(rows, 'restartpoints_done'), kind: 'count' },
			{ metric: 'Write time (ms)', value: writeTime, kind: 'duration_ms' },
			{ metric: 'Sync time (ms)', value: syncTime, kind: 'duration_ms' },
			{ metric: 'Buffers written', value: delta(rows, 'buffers_written'), kind: 'count' },
			{ metric: 'Stats reset', value: latestText(rows, 'stats_reset'), kind: 'text' }
		])
	};
}

export function buildRunTelemetry(db: Database.Database, runId: number, phases?: string[]): RunTelemetry {
	const selectedPhases = parsePhases(phases);
	const run = db.prepare(`
		SELECT r.id, r.design_id, COALESCE(NULLIF(r.database, ''), d.database) AS database,
		       r.started_at, r.bench_started_at, r.post_started_at
		FROM benchmark_runs r
		JOIN designs d ON d.id = r.design_id
		WHERE r.id = ?
	`).get(runId) as RunMeta | undefined;

	if (!run) {
		throw new Error(`Run ${runId} not found`);
	}

	const runStartMs = toMs(run.started_at) ?? 0;
	const availablePhases = detectAvailablePhases(db, runId, run.database);

	const databaseRows = fetchRows(db, 'snap_pg_stat_database', runId, selectedPhases, {
		databaseName: run.database,
		datnameColumn: 'datname'
	});
	const conflictRows = fetchRows(db, 'snap_pg_stat_database_conflicts', runId, selectedPhases, {
		databaseName: run.database,
		datnameColumn: 'datname'
	});
	const walRows = fetchRows(db, 'snap_pg_stat_wal', runId, selectedPhases);
	const bgwriterRows = fetchRows(db, 'snap_pg_stat_bgwriter', runId, selectedPhases);
	const checkpointerRows = fetchRows(db, 'snap_pg_stat_checkpointer', runId, selectedPhases);
	const archiverRows = fetchRows(db, 'snap_pg_stat_archiver', runId, selectedPhases);
	const ioRows = fetchRows(db, 'snap_pg_stat_io', runId, selectedPhases);
	const userTableRows = fetchRows(db, 'snap_pg_stat_user_tables', runId, selectedPhases);
	const userIndexRows = fetchRows(db, 'snap_pg_stat_user_indexes', runId, selectedPhases);
	const statioUserTableRows = fetchRows(db, 'snap_pg_statio_user_tables', runId, selectedPhases);
	const statioUserIndexRows = fetchRows(db, 'snap_pg_statio_user_indexes', runId, selectedPhases);

	const databaseSection = buildDatabaseSection(databaseRows, runStartMs);
	const walSection = buildWalSection(walRows, runStartMs, toNumber(databaseSection.summary.find((card) => card.key === 'transactions')?.value));
	const sections: TelemetrySection[] = [
		databaseSection,
		buildDatabaseConflictsSection(conflictRows, runStartMs),
		walSection,
		buildBgwriterSection(bgwriterRows, runStartMs),
		buildCheckpointerSection(checkpointerRows, runStartMs),
		buildArchiverSection(archiverRows, runStartMs),
		buildIoSection(ioRows, runStartMs),
		buildUserTablesSection(userTableRows, runStartMs),
		buildUserIndexesSection(userIndexRows, runStartMs),
		buildStatioUserTablesSection(statioUserTableRows, runStartMs),
		buildStatioUserIndexesSection(statioUserIndexRows, runStartMs)
	];

	const markers: TelemetryMarker[] = [];
	const benchMarker = toMs(run.bench_started_at);
	if (benchMarker !== null) markers.push({ t: benchMarker - runStartMs, label: 'bench', color: '#0066cc' });
	const postMarker = toMs(run.post_started_at);
	if (postMarker !== null) markers.push({ t: postMarker - runStartMs, label: 'post', color: '#e6531d' });

	const heroCards: TelemetryCard[] = [
		metricCard('transactions', 'Transactions', 'count', databaseSection.summary.find((card) => card.key === 'transactions')?.value ?? null),
		metricCard('db_tps', 'DB-stat TPS', 'tps', databaseSection.summary.find((card) => card.key === 'tps')?.value ?? null),
		metricCard('buffer_hit_ratio', 'Buffer Hit Ratio', 'percent', databaseSection.summary.find((card) => card.key === 'buffer_hit_ratio')?.value ?? null),
		metricCard('wal_bytes', 'WAL Bytes', 'bytes', walSection.summary.find((card) => card.key === 'wal_bytes')?.value ?? null),
		metricCard('wal_per_tx', 'WAL / Tx', 'bytes', walSection.summary.find((card) => card.key === 'wal_bytes_per_tx')?.value ?? null),
		metricCard('temp_bytes', 'Temp Bytes', 'bytes', databaseSection.summary.find((card) => card.key === 'temp_bytes')?.value ?? null),
		metricCard('requested_checkpoints', 'Requested Checkpoints', 'count', sections.find((section) => section.key === 'checkpointer')?.summary.find((card) => card.key === 'num_requested')?.value ?? null),
		metricCard('deadlocks', 'Deadlocks', 'count', delta(databaseRows, 'deadlocks'))
	];

	return {
		runId,
		database: run.database,
		originTs: run.started_at,
		availablePhases,
		selectedPhases,
		markers,
		heroCards,
		sections
	};
}
