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

export interface TelemetryChartMetric {
	key: string;
	label: string;
	kind: TelemetryValueKind;
	title: string;
	series: TelemetrySeries[];
}

export interface TelemetryMarker {
	t: number;
	label: string;
	color?: string;
}

export interface TelemetryTableSnapshot {
	t: number;
	rows: Record<string, unknown>[];
}

export interface TelemetrySection {
	key: string;
	label: string;
	status: TelemetryStatus;
	reason?: string;
	summary: TelemetryCard[];
	chartTitle: string;
	chartSeries: TelemetrySeries[];
	chartMetrics?: TelemetryChartMetric[];
	defaultChartMetricKey?: string;
	tableTitle: string;
	tableColumns: TelemetryTableColumn[];
	tableRows: Record<string, unknown>[];
	tableSnapshots?: TelemetryTableSnapshot[];
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

const COLORS = ['#0066cc', '#e6531d', '#00996b', '#9b36b7', '#cc8800', '#008b8b', '#b22222', '#2f6fed'];
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
	temp_bytes_per_tx:
		'Average temporary-file bytes per transaction: temp_bytes divided by total transactions. Higher values often indicate spills from sorts or hashes.',
	rollback_ratio:
		'Share of transactions that rolled back: xact_rollback / (xact_commit + xact_rollback). Higher values can point to contention, retries, or application errors.',
	blk_read_time_per_tx:
		'Average block read time per transaction: blk_read_time divided by total transactions. This is a quick signal for how much disk-read latency each transaction absorbed.',
	wal_bytes: 'Total WAL volume generated, calculated from the pg_stat_wal.wal_bytes delta.',
	wal_bytes_per_sec:
		'Average WAL generation rate in bytes per second: WAL bytes divided by elapsed time between the first and last pg_stat_wal snapshots.',
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
	index_hits: 'Index blocks found in shared buffers across tracked user indexes.',
	index_hit_ratio:
		'Average share of index block access served from cache across tracked indexes.',
	num_requested:
		'Checkpoints requested before the normal schedule, often because PostgreSQL hit WAL pressure.',
	requested_checkpoints:
		'Checkpoints requested before the normal schedule, often because PostgreSQL hit WAL pressure.',
	num_timed: 'Checkpoints started by the regular checkpoint_timeout schedule.',
	checkpoint_pressure:
		'Share of checkpoints that were forced instead of timed: num_requested / (num_requested + num_timed). Higher values often mean WAL pressure or aggressive write bursts.',
	avg_checkpoint_write_ms:
		'Average checkpoint write time: total write_time divided by requested + timed checkpoints in the selected phases.',
	write_time:
		'Total time PostgreSQL spent writing buffers during checkpoints, shown as the delta of pg_stat_checkpointer.write_time.',
	sync_time:
		'Total time PostgreSQL spent syncing checkpoint files to disk, shown as the delta of pg_stat_checkpointer.sync_time.',
	deadlocks: 'Number of deadlocks reported by pg_stat_database during the selected phases.',
	dead_tuples_per_1k_writes:
		'Dead tuples created per 1,000 writes across tracked user tables. This normalizes dead tuple growth by write volume so bloat pressure is easier to compare between runs.',
	sequence_activity: 'Sequence block activity, calculated as blks_read + blks_hit across tracked user sequences.',
	sequence_hits: 'Sequence blocks served from shared buffers across tracked user sequences.',
	sequence_reads: 'Sequence blocks read from disk across tracked user sequences.',
	sequence_hit_ratio:
		'Average share of sequence block access served from cache across tracked user sequences.',
	cw_cpu_peak:
		'Peak CPU utilization seen in the selected CloudWatch samples. Uses the maximum sampled CPUUtilization value, or EM CPU total when standard CPUUtilization is unavailable.',
	cw_mem_min:
		'Lowest FreeableMemory value seen in the selected CloudWatch samples. This is the minimum sampled amount of reclaimable memory reported by RDS.',
	cw_conn_peak:
		'Highest DatabaseConnections value seen in the selected CloudWatch samples. This is the maximum sampled number of open database connections.',
	em_mem_free_min:
		'Lowest Enhanced Monitoring free-memory value seen in the selected samples. Uses the minimum sampled em_memory_free metric.',
	em_cpu_wait_peak:
		'Highest Enhanced Monitoring CPU IO-wait percentage seen in the selected samples. Uses the maximum sampled em_cpu_wait value.'
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

function elapsedSecondsAt(rows: SnapshotRow[], index: number): number | null {
	if (rows.length < 2 || index <= 0 || index >= rows.length) return null;
	const first = toMs(rows[0]._collected_at);
	const current = toMs(rows[index]._collected_at);
	if (first === null || current === null || current <= first) return null;
	return (current - first) / 1000;
}

function makeMetricRows(metrics: Array<{ metric: string; value: unknown; kind?: TelemetryValueKind }>): Record<string, unknown>[] {
	return metrics.map(({ metric, value, kind }) => ({ metric, value, value_kind: kind ?? 'text' }));
}

function metricCard(key: string, label: string, kind: TelemetryValueKind, value: number | string | boolean | null): TelemetryCard {
	return { key, label, kind, value, infoText: METRIC_INFO[key] };
}

function relPoint(row: SnapshotRow, runStartMs: number, value: number): TelemetrySeriesPoint | null {
	const t = relTime(row, runStartMs);
	if (t === null || !Number.isFinite(value)) return null;
	return { t, v: value };
}

function relTime(row: SnapshotRow, runStartMs: number): number | null {
	const collectedMs = toMs(row._collected_at);
	return collectedMs === null ? null : collectedMs - runStartMs;
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

function buildGroupedSeries(
	entries: Array<{ key: string; label: string; rows: SnapshotRow[] }>,
	runStartMs: number,
	valueAtIndex: (rows: SnapshotRow[], index: number) => number | null
): TelemetrySeries[] {
	return entries
		.map((entry, index) => {
			const sorted = sortRows(entry.rows);
			if (sorted.length === 0) return null;
			const points = sorted
				.map((row, rowIndex) => {
					const value = valueAtIndex(sorted, rowIndex);
					if (value === null || !Number.isFinite(value)) return null;
					return relPoint(row, runStartMs, value);
				})
				.filter((point): point is TelemetrySeriesPoint => point !== null);
			if (points.length === 0) return null;
			return { label: entry.label, color: COLORS[index % COLORS.length], points };
		})
		.filter((series): series is TelemetrySeries => series !== null);
}

// Builds TelemetrySeries for derived/computed metrics (ratios, rates, averages).
// Unlike buildMetricSeries, seriesValueAt receives the full rows array so it can compute
// delta-based ratios (e.g. cache hit rate = Δhit / (Δhit + Δread)) at each snapshot.
function buildDerivedSeries(
	rows: SnapshotRow[],
	runStartMs: number,
	metrics: Array<{ label: string; seriesValueAt: (rows: SnapshotRow[], index: number) => number | null }>,
	colorOffset = 0
): TelemetrySeries[] {
	return metrics
		.map((metric, index) => {
			if (rows.length === 0) return null;
			const points = rows
				.map((row, rowIndex) => {
					const value = metric.seriesValueAt(rows, rowIndex);
					if (value === null || !Number.isFinite(value)) return null;
					return relPoint(row, runStartMs, value);
				})
				.filter((point): point is TelemetrySeriesPoint => point !== null);
			if (points.length === 0) return null;
			return { label: metric.label, color: COLORS[(colorOffset + index) % COLORS.length], points };
		})
		.filter((series): series is TelemetrySeries => series !== null);
}

function deltaAt(rows: SnapshotRow[], index: number, field: string): number | null {
	if (rows.length === 0 || index < 0 || index >= rows.length) return null;
	const first = toNumber(rows[0][field]);
	const current = toNumber(rows[index][field]);
	if (first === null || current === null) return null;
	return current - first;
}

function sumDeltaAt(rows: SnapshotRow[], index: number, fields: string[]): number | null {
	return sum(fields.map((field) => deltaAt(rows, index, field)));
}

function ratioAt(rows: SnapshotRow[], index: number, numeratorField: string, denominatorFields: string[]): number | null {
	return safeRatio(deltaAt(rows, index, numeratorField), sum(denominatorFields.map((field) => deltaAt(rows, index, field))));
}

function buildGroupedMetricCharts<T extends { key: string; label: string; rows: SnapshotRow[] }>(
	entries: T[],
	runStartMs: number,
	metrics: Array<{
		key: string;
		label: string;
		kind: TelemetryValueKind;
		title: string;
		scoreFn: (entry: T) => number | null;
		seriesValueAt: (rows: SnapshotRow[], index: number) => number | null;
	}>,
	limit = 5
): TelemetryChartMetric[] {
	return metrics
		.map((metric) => {
			const top = topEntries(entries, metric.scoreFn, limit);
			const series = buildGroupedSeries(top.map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows })), runStartMs, metric.seriesValueAt);
			if (series.length === 0) return null;
			return {
				key: metric.key,
				label: metric.label,
				kind: metric.kind,
				title: metric.title,
				series
			};
		})
		.filter((metric): metric is TelemetryChartMetric => metric !== null);
}

function buildMetricTableSnapshots(
	rows: SnapshotRow[],
	runStartMs: number,
	rowsAtIndex: (rows: SnapshotRow[], index: number) => Record<string, unknown>[]
): TelemetryTableSnapshot[] {
	return rows
		.map((row, index) => {
			const t = relTime(row, runStartMs);
			if (t === null) return null;
			return { t, rows: rowsAtIndex(rows, index) };
		})
		.filter((snapshot): snapshot is TelemetryTableSnapshot => snapshot !== null);
}

function buildGroupedTableSnapshots<T extends { rows: SnapshotRow[] }>(
	entries: T[],
	runStartMs: number,
	buildRow: (entry: T, index: number) => Record<string, unknown> | null
): TelemetryTableSnapshot[] {
	const timestamps = new Set<string>();
	for (const entry of entries) {
		for (const row of entry.rows) timestamps.add(String(row._collected_at));
	}

	return [...timestamps]
		.sort((a, b) => a.localeCompare(b))
		.map((collectedAt) => {
			const t = relTime({ _collected_at: collectedAt, _phase: 'bench' }, runStartMs);
			if (t === null) return null;
			const rows = entries
				.map((entry) => {
					const index = entry.rows.findIndex((row) => String(row._collected_at) === collectedAt);
					return index >= 0 ? buildRow(entry, index) : null;
				})
				.filter((row): row is Record<string, unknown> => row !== null);
			if (rows.length === 0) return null;
			return { t, rows };
		})
		.filter((snapshot): snapshot is TelemetryTableSnapshot => snapshot !== null);
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

function prioritizeItems<T>(items: T[], predicate: (item: T) => boolean): T[] {
	return [...items.filter(predicate), ...items.filter((item) => !predicate(item))];
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
		{ table: 'snap_pg_stat_wal' },
		{ table: 'snap_pg_stat_bgwriter' },
		{ table: 'snap_pg_stat_checkpointer' },
		{ table: 'snap_pg_stat_archiver' },
		{ table: 'snap_pg_stat_io' },
		{ table: 'snap_pg_stat_user_tables' },
		{ table: 'snap_pg_stat_user_indexes' },
		{ table: 'snap_pg_statio_user_tables' },
		{ table: 'snap_pg_statio_user_indexes' },
		{ table: 'snap_pg_statio_user_sequences' }
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
			chartTitle: 'Database metrics',
			chartSeries: [],
			tableTitle: 'Database metrics',
			tableColumns: [],
			tableRows: [],
			tableSnapshots: []
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
			metricCard('rollback_ratio', 'Rollback Rate', 'percent', safeRatio(txRollback, totalTransactions)),
			metricCard('temp_bytes', 'Temp Bytes', 'bytes', tempBytes),
			metricCard('blk_read_time_per_tx', 'Block Read Time / Tx', 'duration_ms', safeRatio(delta(rows, 'blk_read_time'), totalTransactions))
		],
		chartTitle: 'Database metrics over time',
		chartSeries: [
			...buildMetricSeries(rows, runStartMs, [
				{
					label: 'transactions',
					valueFn: (row) => sum([toNumber(row.xact_commit), toNumber(row.xact_rollback)])
				},
				{ label: 'commits', valueFn: (row) => toNumber(row.xact_commit) },
				{ label: 'rollbacks', valueFn: (row) => toNumber(row.xact_rollback) },
				{ label: 'blocks read', valueFn: (row) => toNumber(row.blks_read) },
				{ label: 'blocks hit', valueFn: (row) => toNumber(row.blks_hit) },
				{ label: 'rows inserted', valueFn: (row) => toNumber(row.tup_inserted) },
				{ label: 'rows updated', valueFn: (row) => toNumber(row.tup_updated) },
				{ label: 'rows deleted', valueFn: (row) => toNumber(row.tup_deleted) },
				{ label: 'temp bytes', valueFn: (row) => toNumber(row.temp_bytes) },
				{ label: 'deadlocks', valueFn: (row) => toNumber(row.deadlocks) },
				{ label: 'block read time', valueFn: (row) => toNumber(row.blk_read_time) },
				{ label: 'block write time', valueFn: (row) => toNumber(row.blk_write_time) },
				{ label: 'rows returned', valueFn: (row) => toNumber(row.tup_returned) },
				{ label: 'rows fetched', valueFn: (row) => toNumber(row.tup_fetched) },
				{ label: 'temp files', valueFn: (row) => toNumber(row.temp_files) },
				{ label: 'conflicts', valueFn: (row) => toNumber(row.conflicts) },
				{ label: 'checksum failures', valueFn: (row) => toNumber(row.checksum_failures) },
				{ label: 'sessions', valueFn: (row) => toNumber(row.sessions) },
				{ label: 'sessions abandoned', valueFn: (row) => toNumber(row.sessions_abandoned) },
				{ label: 'sessions fatal', valueFn: (row) => toNumber(row.sessions_fatal) },
				{ label: 'sessions killed', valueFn: (row) => toNumber(row.sessions_killed) },
				{ label: 'session time (ms)', valueFn: (row) => toNumber(row.session_time) },
				{ label: 'active time (ms)', valueFn: (row) => toNumber(row.active_time) },
				{ label: 'idle in txn time (ms)', valueFn: (row) => toNumber(row.idle_in_transaction_time) }
			]),
			...buildDerivedSeries(rows, runStartMs, [
				{
					label: '⟳ cache hit rate',
					seriesValueAt: (r, i) => ratioAt(r, i, 'blks_hit', ['blks_hit', 'blks_read'])
				},
				{
					label: '⟳ rollback rate',
					seriesValueAt: (r, i) => ratioAt(r, i, 'xact_rollback', ['xact_commit', 'xact_rollback'])
				},
				{
					label: '⟳ avg block read time (ms/block)',
					seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'blk_read_time'), deltaAt(r, i, 'blks_read'))
				},
				{
					label: '⟳ active backends',
					seriesValueAt: (r, i) => toNumber(r[i].numbackends)
				},
				{
					label: '⟳ active time ratio',
					seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'active_time'), deltaAt(r, i, 'session_time'))
				},
				{
					label: '⟳ idle in txn ratio',
					seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'idle_in_transaction_time'), deltaAt(r, i, 'session_time'))
				},
				{
					label: '⟳ rows returned / tx',
					seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_returned'), sum([deltaAt(r, i, 'xact_commit'), deltaAt(r, i, 'xact_rollback')]))
				},
				{
					label: '⟳ session error rate',
					seriesValueAt: (r, i) => safeRatio(sum([deltaAt(r, i, 'sessions_abandoned'), deltaAt(r, i, 'sessions_fatal'), deltaAt(r, i, 'sessions_killed')]), deltaAt(r, i, 'sessions'))
				}
			], 24)
		],
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
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) => {
			const commit = deltaAt(snapshotRows, index, 'xact_commit');
			const rollback = deltaAt(snapshotRows, index, 'xact_rollback');
			const transactions = sum([commit, rollback]);
			return makeMetricRows([
				{ metric: 'Transactions', value: transactions, kind: 'count' },
				{ metric: 'Commits', value: commit, kind: 'count' },
				{ metric: 'Rollbacks', value: rollback, kind: 'count' },
				{ metric: 'DB-stat TPS', value: safeRatio(transactions, elapsedSecondsAt(snapshotRows, index)), kind: 'tps' },
				{ metric: 'Buffer hit ratio', value: ratioAt(snapshotRows, index, 'blks_hit', ['blks_hit', 'blks_read']), kind: 'percent' },
				{ metric: 'Blocks read', value: deltaAt(snapshotRows, index, 'blks_read'), kind: 'count' },
				{ metric: 'Blocks hit', value: deltaAt(snapshotRows, index, 'blks_hit'), kind: 'count' },
				{ metric: 'Rows inserted', value: deltaAt(snapshotRows, index, 'tup_inserted'), kind: 'count' },
				{ metric: 'Rows updated', value: deltaAt(snapshotRows, index, 'tup_updated'), kind: 'count' },
				{ metric: 'Rows deleted', value: deltaAt(snapshotRows, index, 'tup_deleted'), kind: 'count' },
				{ metric: 'Temp bytes', value: deltaAt(snapshotRows, index, 'temp_bytes'), kind: 'bytes' },
				{ metric: 'Deadlocks', value: deltaAt(snapshotRows, index, 'deadlocks'), kind: 'count' },
				{ metric: 'Block read time (ms)', value: deltaAt(snapshotRows, index, 'blk_read_time'), kind: 'duration_ms' },
				{ metric: 'Block write time (ms)', value: deltaAt(snapshotRows, index, 'blk_write_time'), kind: 'duration_ms' }
			]);
		})
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
			chartTitle: 'WAL metrics',
			chartSeries: [],
			tableTitle: 'WAL metrics',
			tableColumns: [],
			tableRows: [],
			tableSnapshots: []
		};
	}

	return {
		key: 'wal',
		label: 'WAL',
		status: 'ok',
		summary: [
			metricCard('wal_bytes', 'WAL Bytes', 'bytes', walBytes),
			metricCard('wal_bytes_per_sec', 'WAL Rate', 'bytes', safeRatio(walBytes, elapsedSeconds(rows))),
			metricCard('wal_bytes_per_tx', 'WAL / Tx', 'bytes', safeRatio(walBytes, transactions)),
			metricCard('fpi_ratio', 'FPI Ratio', 'percent', safeRatio(walFpi, walRecords)),
			metricCard('wal_buffers_full', 'WAL Buffers Full', 'count', walBuffersFull)
		],
		chartTitle: 'WAL metrics over time',
		chartSeries: [
			...buildMetricSeries(rows, runStartMs, [
				{ label: 'wal bytes', valueFn: (row) => toNumber(row.wal_bytes) },
				{ label: 'wal records', valueFn: (row) => toNumber(row.wal_records) },
				{ label: 'full page images', valueFn: (row) => toNumber(row.wal_fpi) },
				{ label: 'wal buffers full', valueFn: (row) => toNumber(row.wal_buffers_full) }
			]),
			...buildDerivedSeries(rows, runStartMs, [
				{
					label: '⟳ FPI ratio (fpi / records)',
					seriesValueAt: (r, i) => ratioAt(r, i, 'wal_fpi', ['wal_records'])
				},
				{
					label: '⟳ avg WAL bytes / record',
					seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_bytes'), deltaAt(r, i, 'wal_records'))
				}
			], 4)
		],
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
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) =>
			makeMetricRows([
				{ metric: 'WAL bytes', value: deltaAt(snapshotRows, index, 'wal_bytes'), kind: 'bytes' },
				{ metric: 'WAL records', value: deltaAt(snapshotRows, index, 'wal_records'), kind: 'count' },
				{ metric: 'Full page images', value: deltaAt(snapshotRows, index, 'wal_fpi'), kind: 'count' },
				{
					metric: 'FPI ratio',
					value: safeRatio(deltaAt(snapshotRows, index, 'wal_fpi'), deltaAt(snapshotRows, index, 'wal_records')),
					kind: 'percent'
				},
				{ metric: 'WAL buffers full', value: deltaAt(snapshotRows, index, 'wal_buffers_full'), kind: 'count' }
			])
		)
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
			tableRows: [],
			tableSnapshots: []
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
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) =>
			makeMetricRows([
				{ metric: 'Buffers clean', value: deltaAt(snapshotRows, index, 'buffers_clean'), kind: 'count' },
				{ metric: 'Maxwritten clean', value: deltaAt(snapshotRows, index, 'maxwritten_clean'), kind: 'count' },
				{ metric: 'Buffers alloc', value: deltaAt(snapshotRows, index, 'buffers_alloc'), kind: 'count' },
				{ metric: 'Stats reset', value: snapshotRows[index].stats_reset == null ? null : String(snapshotRows[index].stats_reset), kind: 'text' }
			])
		)
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
			tableRows: [],
			tableSnapshots: []
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
		chartSeries: [
			...buildMetricSeries(rows, runStartMs, [
				{ label: 'archived', valueFn: (row) => toNumber(row.archived_count) },
				{ label: 'failed', valueFn: (row) => toNumber(row.failed_count) }
			]),
			...buildDerivedSeries(rows, runStartMs, [
				{
					label: '⟳ archive failure rate',
					seriesValueAt: (r, i) => ratioAt(r, i, 'failed_count', ['archived_count', 'failed_count'])
				}
			], 2)
		],
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
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) =>
			makeMetricRows([
				{ metric: 'Archived segments', value: deltaAt(snapshotRows, index, 'archived_count'), kind: 'count' },
				{ metric: 'Archive failures', value: deltaAt(snapshotRows, index, 'failed_count'), kind: 'count' },
				{ metric: 'Last archived WAL', value: snapshotRows[index].last_archived_wal == null ? null : String(snapshotRows[index].last_archived_wal), kind: 'text' },
				{ metric: 'Last archived at', value: snapshotRows[index].last_archived_time == null ? null : String(snapshotRows[index].last_archived_time), kind: 'text' },
				{ metric: 'Last failed WAL', value: snapshotRows[index].last_failed_wal == null ? null : String(snapshotRows[index].last_failed_wal), kind: 'text' },
				{ metric: 'Last failure at', value: snapshotRows[index].last_failed_time == null ? null : String(snapshotRows[index].last_failed_time), kind: 'text' }
			])
		)
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
			tableRows: [],
			tableSnapshots: []
		};
	}

	const grouped = groupRows(rows, (row) => `${row.backend_type ?? 'unknown'}|${row.object ?? 'unknown'}|${row.context ?? 'unknown'}`);
	const entries = [...grouped.entries()].map(([key, bucket]) => {
		const [backend_type, object, context] = key.split('|');
		const readBytes = delta(bucket, 'read_bytes');
		const writeBytes = delta(bucket, 'write_bytes');
		const extendBytes = delta(bucket, 'extend_bytes');
		const totalBytes = sum([readBytes, writeBytes, extendBytes]);
		const reads = delta(bucket, 'reads');
		const writes = delta(bucket, 'writes');
		const fsyncs = delta(bucket, 'fsyncs');
		const hits = delta(bucket, 'hits');
		const readTime = delta(bucket, 'read_time');
		const writeTime = delta(bucket, 'write_time');
		const extendTime = delta(bucket, 'extend_time');
		const fsyncTime = delta(bucket, 'fsync_time');
		return {
			key,
			label: `${backend_type}/${object}/${context}`,
			backend_type,
			object,
			context,
			rows: bucket,
			totalBytes,
			reads,
			readBytes,
			writes,
			writeBytes,
			extends: delta(bucket, 'extends'),
			extendBytes,
			hits,
			evictions: delta(bucket, 'evictions'),
			fsyncs,
			writebacks: delta(bucket, 'writebacks'),
			writebackTime: delta(bucket, 'writeback_time'),
			reuses: delta(bucket, 'reuses'),
			readTime,
			writeTime,
			extendTime,
			fsyncTime
		};
	});
	const topGroups = topEntries(entries, (entry) => entry.totalBytes ?? sum([entry.reads, entry.writes]));
	const chartMetrics = buildGroupedMetricCharts(entries, runStartMs, [
		{
			key: 'read_bytes',
			label: 'Read Bytes',
			kind: 'bytes',
			title: 'Top IO groups by read bytes over time',
			scoreFn: (entry) => entry.readBytes,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'read_bytes')
		},
		{
			key: 'reads',
			label: 'Reads',
			kind: 'count',
			title: 'Top IO groups by reads over time',
			scoreFn: (entry) => entry.reads,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'reads')
		},
		{
			key: 'write_bytes',
			label: 'Write Bytes',
			kind: 'bytes',
			title: 'Top IO groups by write bytes over time',
			scoreFn: (entry) => entry.writeBytes,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'write_bytes')
		},
		{
			key: 'writes',
			label: 'Writes',
			kind: 'count',
			title: 'Top IO groups by writes over time',
			scoreFn: (entry) => entry.writes,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'writes')
		},
		{
			key: 'extend_bytes',
			label: 'Extend Bytes',
			kind: 'bytes',
			title: 'Top IO groups by extend bytes over time',
			scoreFn: (entry) => entry.extendBytes,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'extend_bytes')
		},
		{
			key: 'extends',
			label: 'Extends',
			kind: 'count',
			title: 'Top IO groups by extends over time',
			scoreFn: (entry) => entry.extends,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'extends')
		},
		{
			key: 'hits',
			label: 'Hits',
			kind: 'count',
			title: 'Top IO groups by hits over time',
			scoreFn: (entry) => entry.hits,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'hits')
		},
		{
			key: 'evictions',
			label: 'Evictions',
			kind: 'count',
			title: 'Top IO groups by evictions over time',
			scoreFn: (entry) => entry.evictions,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'evictions')
		},
		{
			key: 'fsyncs',
			label: 'FSyncs',
			kind: 'count',
			title: 'Top IO groups by fsyncs over time',
			scoreFn: (entry) => entry.fsyncs,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'fsyncs')
		},
		{
			key: 'read_time',
			label: 'Read Time (ms)',
			kind: 'duration_ms',
			title: 'Top IO groups by read time over time',
			scoreFn: (entry) => entry.readTime,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'read_time')
		},
		{
			key: 'write_time',
			label: 'Write Time (ms)',
			kind: 'duration_ms',
			title: 'Top IO groups by write time over time',
			scoreFn: (entry) => entry.writeTime,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'write_time')
		},
		{
			key: 'extend_time',
			label: 'Extend Time (ms)',
			kind: 'duration_ms',
			title: 'Top IO groups by extend time over time',
			scoreFn: (entry) => entry.extendTime,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'extend_time')
		},
		{
			key: 'fsync_time',
			label: 'FSync Time (ms)',
			kind: 'duration_ms',
			title: 'Top IO groups by fsync time over time',
			scoreFn: (entry) => entry.fsyncTime,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'fsync_time')
		},
		{
			key: 'writebacks',
			label: 'Writebacks',
			kind: 'count',
			title: 'Top IO groups by writebacks over time',
			scoreFn: (entry) => entry.writebacks,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'writebacks')
		},
		{
			key: 'reuses',
			label: 'Reuses',
			kind: 'count',
			title: 'Top IO groups by buffer reuses over time',
			scoreFn: (entry) => entry.reuses,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'reuses')
		},
		{
			key: 'avg_read_time_ms',
			label: '⟳ Avg Read Time (ms)',
			kind: 'duration_ms',
			title: 'Average time per read operation over time',
			scoreFn: (entry) => safeRatio(entry.readTime, entry.reads),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'read_time'), deltaAt(groupRows, index, 'reads'))
		},
		{
			key: 'avg_write_time_ms',
			label: '⟳ Avg Write Time (ms)',
			kind: 'duration_ms',
			title: 'Average time per write operation over time',
			scoreFn: (entry) => safeRatio(entry.writeTime, entry.writes),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'write_time'), deltaAt(groupRows, index, 'writes'))
		},
		{
			key: 'avg_fsync_time_ms',
			label: '⟳ Avg FSync Time (ms)',
			kind: 'duration_ms',
			title: 'Average time per fsync call over time',
			scoreFn: (entry) => safeRatio(entry.fsyncTime, entry.fsyncs),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'fsync_time'), deltaAt(groupRows, index, 'fsyncs'))
		},
		{
			key: 'read_miss_ratio',
			label: '⟳ Read Miss Ratio',
			kind: 'percent',
			title: 'Cache miss rate (reads / (reads + hits)) over time — lower is better',
			scoreFn: (entry) => safeRatio(entry.reads, sum([entry.reads, entry.hits])),
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'reads', ['reads', 'hits'])
		}
	]);

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
		chartTitle: chartMetrics[0]?.title ?? 'Top IO groups by read bytes over time',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
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
		})),
		tableSnapshots: buildGroupedTableSnapshots(topGroups, runStartMs, (entry, index) => ({
			group: entry.label,
			reads: deltaAt(entry.rows, index, 'reads'),
			read_bytes: deltaAt(entry.rows, index, 'read_bytes'),
			writes: deltaAt(entry.rows, index, 'writes'),
			write_bytes: deltaAt(entry.rows, index, 'write_bytes'),
			extends: deltaAt(entry.rows, index, 'extends'),
			extend_bytes: deltaAt(entry.rows, index, 'extend_bytes'),
			hits: deltaAt(entry.rows, index, 'hits'),
			evictions: deltaAt(entry.rows, index, 'evictions'),
			fsyncs: deltaAt(entry.rows, index, 'fsyncs')
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
			tableRows: [],
			tableSnapshots: []
		};
	}

	const grouped = groupRows(rows, (row) => String(row.relname ?? 'unknown'));
	const entries = [...grouped.entries()].map(([relname, bucket]) => {
		const writes = sum([delta(bucket, 'n_tup_ins'), delta(bucket, 'n_tup_upd'), delta(bucket, 'n_tup_del')]);
		const seqScans = delta(bucket, 'seq_scan');
		const idxScans = delta(bucket, 'idx_scan');
		const hotUpdates = delta(bucket, 'n_tup_hot_upd');
		const updates = delta(bucket, 'n_tup_upd');
		const seqTupRead = delta(bucket, 'seq_tup_read');
		const idxTupFetch = delta(bucket, 'idx_tup_fetch');
		const newpageUpd = delta(bucket, 'n_tup_newpage_upd');
		const vacuumActivity = sum([delta(bucket, 'vacuum_count'), delta(bucket, 'autovacuum_count')]);
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
			})(),
			seqTupRead,
			idxTupFetch,
			newpageUpd,
			vacuumActivity
		};
	});
	const topTables = topEntries(entries, (entry) => entry.writes);
	const chartMetrics = buildGroupedMetricCharts(entries, runStartMs, [
		{
			key: 'writes',
			label: 'Writes',
			kind: 'count',
			title: 'Top tables by writes over time',
			scoreFn: (entry) => entry.writes,
			seriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['n_tup_ins', 'n_tup_upd', 'n_tup_del'])
		},
		{
			key: 'seq_scan_ratio',
			label: 'Seq Scan Ratio',
			kind: 'percent',
			title: 'Top tables by seq scan ratio over time',
			scoreFn: (entry) => entry.seqScanRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'seq_scan', ['seq_scan', 'idx_scan'])
		},
		{
			key: 'hot_update_ratio',
			label: 'HOT Update Ratio',
			kind: 'percent',
			title: 'Top tables by HOT update ratio over time',
			scoreFn: (entry) => entry.hotRatio,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'n_tup_hot_upd'), deltaAt(groupRows, index, 'n_tup_upd'))
		},
		{
			key: 'dead_tuple_growth',
			label: 'Dead Tuple Growth',
			kind: 'count',
			title: 'Top tables by dead tuple growth over time',
			scoreFn: (entry) => entry.deadTupleGrowth,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'n_dead_tup')
		},
		{
			key: 'dead_tuple_ratio',
			label: '⟳ Dead Tuple Ratio',
			kind: 'percent',
			title: 'Dead tuple ratio over time (dead / total rows) — autovacuum backlog indicator',
			scoreFn: (entry) => entry.deadTupleGrowth,
			seriesValueAt: (groupRows, index) => {
				const dead = toNumber(groupRows[index].n_dead_tup);
				const live = toNumber(groupRows[index].n_live_tup);
				if (dead === null || live === null) return null;
				const total = dead + live;
				return total > 0 ? dead / total : 0;
			}
		},
		{
			key: 'index_scan_ratio',
			label: '⟳ Index Scan Ratio',
			kind: 'percent',
			title: 'Index scan ratio over time (idx_scan / total scans) — inverse of seq scan ratio',
			scoreFn: (entry) => entry.writes,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'idx_scan', ['seq_scan', 'idx_scan'])
		},
		{
			key: 'seq_tup_read',
			label: 'Seq Tuples Read',
			kind: 'count',
			title: 'Top tables by rows returned from sequential scans over time',
			scoreFn: (entry) => entry.seqTupRead,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'seq_tup_read')
		},
		{
			key: 'idx_tup_fetch',
			label: 'Idx Tuples Fetched',
			kind: 'count',
			title: 'Top tables by rows fetched via index scans over time',
			scoreFn: (entry) => entry.idxTupFetch,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_tup_fetch')
		},
		{
			key: 'vacuum_activity',
			label: '⟳ Vacuum Activity',
			kind: 'count',
			title: 'Vacuum + autovacuum runs per table over time',
			scoreFn: (entry) => entry.vacuumActivity,
			seriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['vacuum_count', 'autovacuum_count'])
		},
		{
			key: 'newpage_update_ratio',
			label: '⟳ New-Page Update Ratio',
			kind: 'percent',
			title: 'Share of updates that moved tuples to a new page (bloat indicator, PG16+)',
			scoreFn: (entry) => entry.newpageUpd,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'n_tup_newpage_upd'), deltaAt(groupRows, index, 'n_tup_upd'))
		},
		{
			key: 'rows_per_seq_scan',
			label: '⟳ Rows / Seq Scan',
			kind: 'count',
			title: 'Average rows returned per sequential scan over time — large values on large tables suggest missing indexes',
			scoreFn: (entry) => entry.seqTupRead,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'seq_tup_read'), deltaAt(groupRows, index, 'seq_scan'))
		}
	]);

	return {
		key: 'user_tables',
		label: 'User Tables',
		status: 'ok',
		summary: [
			metricCard('total_writes', 'Total Writes', 'count', sum(entries.map((entry) => entry.writes))),
			metricCard('avg_seq_ratio', 'Avg Seq Scan Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.seqScanRatio)), entries.length || null)),
			metricCard('avg_hot_ratio', 'Avg HOT Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.hotRatio)), entries.length || null)),
			metricCard('dead_tuple_growth', 'Dead Tuple Growth', 'count', sum(entries.map((entry) => entry.deadTupleGrowth))),
			metricCard('dead_tuples_per_1k_writes', 'Dead Tuples / 1k Writes', 'count',
				safeRatio(
					(sum(entries.map((entry) => entry.deadTupleGrowth)) ?? 0) * 1000,
					sum(entries.map((entry) => entry.writes))
				)
			)
		],
		chartTitle: chartMetrics[0]?.title ?? 'Top tables by writes over time',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
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
		})),
		tableSnapshots: buildGroupedTableSnapshots(topTables, runStartMs, (entry, index) => ({
			table: entry.label,
			writes: sumDeltaAt(entry.rows, index, ['n_tup_ins', 'n_tup_upd', 'n_tup_del']),
			seq_scan_ratio: ratioAt(entry.rows, index, 'seq_scan', ['seq_scan', 'idx_scan']),
			hot_update_ratio: safeRatio(deltaAt(entry.rows, index, 'n_tup_hot_upd'), deltaAt(entry.rows, index, 'n_tup_upd')),
			dead_tuple_growth: deltaAt(entry.rows, index, 'n_dead_tup')
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
			tableRows: [],
			tableSnapshots: []
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
	const chartMetrics = buildGroupedMetricCharts(entries, runStartMs, [
		{
			key: 'idx_scans',
			label: 'Idx Scans',
			kind: 'count',
			title: 'Top indexes by scans over time',
			scoreFn: (entry) => entry.idxScans,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_scan')
		},
		{
			key: 'idx_tup_read',
			label: 'Tuples Read',
			kind: 'count',
			title: 'Top indexes by tuples read over time',
			scoreFn: (entry) => entry.idxRead,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_tup_read')
		},
		{
			key: 'idx_tup_fetch',
			label: 'Tuples Fetch',
			kind: 'count',
			title: 'Top indexes by tuples fetched over time',
			scoreFn: (entry) => entry.idxFetch,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_tup_fetch')
		},
		{
			key: 'selectivity',
			label: 'Selectivity',
			kind: 'percent',
			title: 'Top indexes by selectivity over time',
			scoreFn: (entry) => entry.selectivity,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_tup_fetch'), deltaAt(groupRows, index, 'idx_tup_read'))
		}
	]);

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
		chartTitle: chartMetrics[0]?.title ?? 'Top indexes by scans over time',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
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
		})),
		tableSnapshots: buildGroupedTableSnapshots(topIndexes, runStartMs, (entry, index) => {
			const idxScans = deltaAt(entry.rows, index, 'idx_scan');
			return {
				index: entry.label,
				idx_scans: idxScans,
				idx_tup_read: deltaAt(entry.rows, index, 'idx_tup_read'),
				idx_tup_fetch: deltaAt(entry.rows, index, 'idx_tup_fetch'),
				selectivity: safeRatio(deltaAt(entry.rows, index, 'idx_tup_fetch'), deltaAt(entry.rows, index, 'idx_tup_read')),
				unused: (idxScans ?? 0) === 0
			};
		})
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
			tableRows: [],
			tableSnapshots: []
		};
	}

	const grouped = groupRows(rows, (row) => String(row.relname ?? 'unknown'));
	const entries = [...grouped.entries()].map(([relname, bucket]) => {
		const heapReads = delta(bucket, 'heap_blks_read');
		const heapHits = delta(bucket, 'heap_blks_hit');
		const heapActivity = sum([heapReads, heapHits]);
		const idxReads = delta(bucket, 'idx_blks_read');
		const idxHits = delta(bucket, 'idx_blks_hit');
		const toastReads = delta(bucket, 'toast_blks_read');
		const toastHits = delta(bucket, 'toast_blks_hit');
		const tidxReads = delta(bucket, 'tidx_blks_read');
		const tidxHits = delta(bucket, 'tidx_blks_hit');
		const totalHits = sum([heapHits, idxHits, toastHits, tidxHits]);
		const totalReads = sum([heapReads, idxReads, toastReads, tidxReads]);
		return {
			key: relname,
			label: relname,
			rows: bucket,
			heapActivity,
			heapReads,
			heapHits,
			heapHitRatio: safeRatio(heapHits, sum([heapHits, heapReads])),
			toasts: toastReads,
			toastReads,
			toastHits,
			idxReads,
			idxHits,
			idxHitRatio: safeRatio(idxHits, sum([idxHits, idxReads])),
			tidxReads,
			tidxHits,
			overallHitRatio: safeRatio(totalHits, sum([totalHits, totalReads]))
		};
	});
	const topTables = topEntries(entries, (entry) => entry.heapActivity);
	const chartMetrics = buildGroupedMetricCharts(entries, runStartMs, [
		{
			key: 'heap_activity',
			label: 'Heap Activity',
			kind: 'count',
			title: 'Top tables by heap activity over time',
			scoreFn: (entry) => entry.heapActivity,
			seriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['heap_blks_read', 'heap_blks_hit'])
		},
		{
			key: 'heap_hits',
			label: 'Heap Hits',
			kind: 'count',
			title: 'Top tables by heap hits over time',
			scoreFn: (entry) => entry.heapHits,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'heap_blks_hit')
		},
		{
			key: 'heap_reads',
			label: 'Heap Reads',
			kind: 'count',
			title: 'Top tables by heap reads over time',
			scoreFn: (entry) => entry.heapReads,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'heap_blks_read')
		},
		{
			key: 'heap_hit_ratio',
			label: 'Heap Hit Ratio',
			kind: 'percent',
			title: 'Top tables by heap hit ratio over time',
			scoreFn: (entry) => entry.heapHitRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'heap_blks_hit', ['heap_blks_hit', 'heap_blks_read'])
		},
		{
			key: 'toast_reads',
			label: 'TOAST Reads',
			kind: 'count',
			title: 'Top tables by TOAST reads over time',
			scoreFn: (entry) => entry.toasts,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'toast_blks_read')
		},
		{
			key: 'idx_blks_read',
			label: 'Idx Blocks Read',
			kind: 'count',
			title: 'Top tables by index block reads over time',
			scoreFn: (entry) => entry.idxReads,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_blks_read')
		},
		{
			key: 'idx_hit_ratio',
			label: '⟳ Idx Hit Ratio',
			kind: 'percent',
			title: 'Per-table index cache hit ratio over time',
			scoreFn: (entry) => entry.idxHitRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'idx_blks_hit', ['idx_blks_hit', 'idx_blks_read'])
		},
		{
			key: 'overall_hit_ratio',
			label: '⟳ Overall Hit Ratio',
			kind: 'percent',
			title: 'Combined cache hit ratio across heap + index + TOAST blocks per table over time',
			scoreFn: (entry) => entry.overallHitRatio,
			seriesValueAt: (groupRows, index) => {
				const hits = sumDeltaAt(groupRows, index, ['heap_blks_hit', 'idx_blks_hit', 'toast_blks_hit', 'tidx_blks_hit']);
				const reads = sumDeltaAt(groupRows, index, ['heap_blks_read', 'idx_blks_read', 'toast_blks_read', 'tidx_blks_read']);
				return safeRatio(hits, sum([hits, reads]));
			}
		}
	]);

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
		chartTitle: chartMetrics[0]?.title ?? 'Top tables by heap activity over time',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
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
		})),
		tableSnapshots: buildGroupedTableSnapshots(topTables, runStartMs, (entry, index) => ({
			table: entry.label,
			heap_activity: sumDeltaAt(entry.rows, index, ['heap_blks_read', 'heap_blks_hit']),
			heap_hits: deltaAt(entry.rows, index, 'heap_blks_hit'),
			heap_reads: deltaAt(entry.rows, index, 'heap_blks_read'),
			heap_hit_ratio: ratioAt(entry.rows, index, 'heap_blks_hit', ['heap_blks_hit', 'heap_blks_read']),
			toast_reads: deltaAt(entry.rows, index, 'toast_blks_read')
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
			tableRows: [],
			tableSnapshots: []
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
			idxHits,
			idxHitRatio: safeRatio(idxHits, sum([idxHits, idxReads]))
		};
	});
	const topIndexes = topEntries(entries, (entry) => entry.idxReads);
	const chartMetrics = buildGroupedMetricCharts(entries, runStartMs, [
		{
			key: 'idx_blks_read',
			label: 'Idx Blocks Read',
			kind: 'count',
			title: 'Top indexes by block reads over time',
			scoreFn: (entry) => entry.idxReads,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_blks_read')
		},
		{
			key: 'idx_blks_hit',
			label: 'Idx Blocks Hit',
			kind: 'count',
			title: 'Top indexes by index block hits (from shared buffers) over time',
			scoreFn: (entry) => entry.idxHits,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_blks_hit')
		},
		{
			key: 'idx_hit_ratio',
			label: 'Idx Hit Ratio',
			kind: 'percent',
			title: 'Top indexes by hit ratio over time',
			scoreFn: (entry) => entry.idxHitRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'idx_blks_hit', ['idx_blks_hit', 'idx_blks_read'])
		}
	]);

	return {
		key: 'statio_user_indexes',
		label: 'Statio User Indexes',
		status: 'ok',
		summary: [
			metricCard('index_reads', 'Index Block Reads', 'count', sum(entries.map((entry) => entry.idxReads))),
			metricCard('index_hits', 'Index Block Hits', 'count', sum(entries.map((entry) => entry.idxHits))),
			metricCard('index_hit_ratio', 'Index Hit Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.idxHitRatio)), entries.length || null))
		],
		chartTitle: chartMetrics[0]?.title ?? 'Top indexes by block reads over time',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
		tableTitle: 'Top indexes by block reads',
		tableColumns: [
			{ key: 'index', label: 'Index', kind: 'text' },
			{ key: 'idx_blks_read', label: 'Idx Blocks Read', kind: 'count' },
			{ key: 'idx_blks_hit', label: 'Idx Blocks Hit', kind: 'count' },
			{ key: 'idx_hit_ratio', label: 'Idx Hit Ratio', kind: 'percent' }
		],
		tableRows: topIndexes.map((entry) => ({
			index: entry.label,
			idx_blks_read: entry.idxReads,
			idx_blks_hit: entry.idxHits,
			idx_hit_ratio: entry.idxHitRatio
		})),
		tableSnapshots: buildGroupedTableSnapshots(topIndexes, runStartMs, (entry, index) => ({
			index: entry.label,
			idx_blks_read: deltaAt(entry.rows, index, 'idx_blks_read'),
			idx_blks_hit: deltaAt(entry.rows, index, 'idx_blks_hit'),
			idx_hit_ratio: ratioAt(entry.rows, index, 'idx_blks_hit', ['idx_blks_hit', 'idx_blks_read'])
		}))
	};
}

function buildStatioUserSequencesSection(rows: SnapshotRow[], runStartMs: number): TelemetrySection {
	if (rows.length === 0) {
		return {
			key: 'statio_user_sequences',
			label: 'Statio User Sequences',
			status: 'no_data',
			reason: 'No pg_statio_user_sequences snapshots were collected for the selected phases.',
			summary: [],
			chartTitle: 'Top sequences by block activity',
			chartSeries: [],
			tableTitle: 'Top sequences',
			tableColumns: [],
			tableRows: [],
			tableSnapshots: []
		};
	}

	const grouped = groupRows(rows, (row) => String(row.relname ?? 'unknown'));
	const entries = [...grouped.entries()].map(([relname, bucket]) => {
		const sequenceReads = delta(bucket, 'blks_read');
		const sequenceHits = delta(bucket, 'blks_hit');
		return {
			key: relname,
			label: relname,
			rows: bucket,
			sequenceActivity: sum([sequenceReads, sequenceHits]),
			sequenceReads,
			sequenceHits,
			sequenceHitRatio: safeRatio(sequenceHits, sum([sequenceHits, sequenceReads]))
		};
	});
	const topSequences = topEntries(entries, (entry) => entry.sequenceActivity);
	const chartMetrics = buildGroupedMetricCharts(entries, runStartMs, [
		{
			key: 'sequence_activity',
			label: 'Sequence Activity',
			kind: 'count',
			title: 'Top sequences by block activity over time',
			scoreFn: (entry) => entry.sequenceActivity,
			seriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['blks_read', 'blks_hit'])
		},
		{
			key: 'sequence_hits',
			label: 'Sequence Hits',
			kind: 'count',
			title: 'Top sequences by block hits over time',
			scoreFn: (entry) => entry.sequenceHits,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'blks_hit')
		},
		{
			key: 'sequence_reads',
			label: 'Sequence Reads',
			kind: 'count',
			title: 'Top sequences by block reads over time',
			scoreFn: (entry) => entry.sequenceReads,
			seriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'blks_read')
		},
		{
			key: 'sequence_hit_ratio',
			label: 'Sequence Hit Ratio',
			kind: 'percent',
			title: 'Top sequences by hit ratio over time',
			scoreFn: (entry) => entry.sequenceHitRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'blks_hit', ['blks_hit', 'blks_read'])
		}
	]);

	return {
		key: 'statio_user_sequences',
		label: 'Statio User Sequences',
		status: 'ok',
		summary: [
			metricCard('sequence_activity', 'Sequence Activity', 'count', sum(entries.map((entry) => entry.sequenceActivity))),
			metricCard('sequence_hits', 'Sequence Hits', 'count', sum(entries.map((entry) => entry.sequenceHits))),
			metricCard('sequence_reads', 'Sequence Reads', 'count', sum(entries.map((entry) => entry.sequenceReads))),
			metricCard('sequence_hit_ratio', 'Sequence Hit Ratio', 'percent', safeRatio(sum(entries.map((entry) => entry.sequenceHitRatio)), entries.length || null))
		],
		chartTitle: chartMetrics[0]?.title ?? 'Top sequences by block activity over time',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
		tableTitle: 'Top sequences by block activity',
		tableColumns: [
			{ key: 'sequence', label: 'Sequence', kind: 'text' },
			{ key: 'sequence_activity', label: 'Sequence Activity', kind: 'count' },
			{ key: 'sequence_hits', label: 'Sequence Hits', kind: 'count' },
			{ key: 'sequence_reads', label: 'Sequence Reads', kind: 'count' },
			{ key: 'sequence_hit_ratio', label: 'Sequence Hit Ratio', kind: 'percent' }
		],
		tableRows: topSequences.map((entry) => ({
			sequence: entry.label,
			sequence_activity: entry.sequenceActivity,
			sequence_hits: entry.sequenceHits,
			sequence_reads: entry.sequenceReads,
			sequence_hit_ratio: entry.sequenceHitRatio
		})),
		tableSnapshots: buildGroupedTableSnapshots(topSequences, runStartMs, (entry, index) => ({
			sequence: entry.label,
			sequence_activity: sumDeltaAt(entry.rows, index, ['blks_read', 'blks_hit']),
			sequence_hits: deltaAt(entry.rows, index, 'blks_hit'),
			sequence_reads: deltaAt(entry.rows, index, 'blks_read'),
			sequence_hit_ratio: ratioAt(entry.rows, index, 'blks_hit', ['blks_hit', 'blks_read'])
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
			tableRows: [],
			tableSnapshots: []
		};
	}

	return {
		key: 'checkpointer',
		label: 'Checkpointer',
		status: 'ok',
		summary: [
			metricCard('num_requested', 'Requested Checkpoints', 'count', numRequested),
			metricCard('num_timed', 'Timed Checkpoints', 'count', numTimed),
			metricCard('checkpoint_pressure', 'Checkpoint Pressure', 'percent',
				safeRatio(numRequested, sum([numRequested, numTimed]))),
			metricCard('avg_checkpoint_write_ms', 'Avg Write Time / Checkpoint', 'duration_ms',
				safeRatio(writeTime, sum([numRequested, numTimed]))),
			metricCard('write_time', 'Write Time', 'duration_ms', writeTime),
			metricCard('sync_time', 'Sync Time', 'duration_ms', syncTime)
		],
		chartTitle: 'Checkpoint activity over time',
		chartSeries: [
			...buildMetricSeries(rows, runStartMs, [
				{ label: 'requested', valueFn: (row) => toNumber(row.num_requested) },
				{ label: 'timed', valueFn: (row) => toNumber(row.num_timed) },
				{ label: 'restartpoints timed', valueFn: (row) => toNumber(row.restartpoints_timed) },
				{ label: 'restartpoints requested', valueFn: (row) => toNumber(row.restartpoints_req) },
				{ label: 'restartpoints done', valueFn: (row) => toNumber(row.restartpoints_done) },
				{ label: 'buffers written', valueFn: (row) => toNumber(row.buffers_written) },
				{ label: 'slru written', valueFn: (row) => toNumber(row.slru_written) },
				{ label: 'write time (ms)', valueFn: (row) => toNumber(row.write_time) },
				{ label: 'sync time (ms)', valueFn: (row) => toNumber(row.sync_time) }
			]),
			...buildDerivedSeries(rows, runStartMs, [
				{
					label: '⟳ checkpoint pressure (% forced)',
					seriesValueAt: (r, i) => ratioAt(r, i, 'num_requested', ['num_requested', 'num_timed'])
				},
				{
					label: '⟳ avg write time / checkpoint (ms)',
					seriesValueAt: (r, i) => safeRatio(
						deltaAt(r, i, 'write_time'),
						sum([deltaAt(r, i, 'num_requested'), deltaAt(r, i, 'num_timed')])
					)
				},
				{
					label: '⟳ buffers / checkpoint',
					seriesValueAt: (r, i) => safeRatio(
						deltaAt(r, i, 'buffers_written'),
						sum([deltaAt(r, i, 'num_requested'), deltaAt(r, i, 'num_timed')])
					)
				},
				{
					label: '⟳ sync / write time ratio',
					seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sync_time'), deltaAt(r, i, 'write_time'))
				}
			], 9)
		],
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
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) =>
			makeMetricRows([
				{ metric: 'Requested checkpoints', value: deltaAt(snapshotRows, index, 'num_requested'), kind: 'count' },
				{ metric: 'Timed checkpoints', value: deltaAt(snapshotRows, index, 'num_timed'), kind: 'count' },
				{ metric: 'Timed restartpoints', value: deltaAt(snapshotRows, index, 'restartpoints_timed'), kind: 'count' },
				{ metric: 'Requested restartpoints', value: deltaAt(snapshotRows, index, 'restartpoints_req'), kind: 'count' },
				{ metric: 'Restartpoints done', value: deltaAt(snapshotRows, index, 'restartpoints_done'), kind: 'count' },
				{ metric: 'Write time (ms)', value: deltaAt(snapshotRows, index, 'write_time'), kind: 'duration_ms' },
				{ metric: 'Sync time (ms)', value: deltaAt(snapshotRows, index, 'sync_time'), kind: 'duration_ms' },
				{ metric: 'Buffers written', value: deltaAt(snapshotRows, index, 'buffers_written'), kind: 'count' },
				{ metric: 'Stats reset', value: snapshotRows[index].stats_reset == null ? null : String(snapshotRows[index].stats_reset), kind: 'text' }
			])
		)
	};
}

function buildOsMetricsSection(db: Database.Database, runId: number, runStartMs: number, selectedPhases: TelemetryPhase[]): TelemetrySection {
	const noData: TelemetrySection = {
		key: 'os_metrics',
		label: 'SSH Metrics',
		status: 'no_data',
		reason: 'No SSH OS metrics were collected for this run. Requires SSH enabled on the database server configuration.',
		summary: [],
		chartTitle: 'OS metrics (via SSH)',
		chartSeries: [],
		tableTitle: 'OS metrics',
		tableColumns: [],
		tableRows: [],
		tableSnapshots: []
	};

	if (!tableExists(db, 'cloudwatch_datapoints')) return noData;

	const phaseClause = selectedPhases.length === ALL_PHASES.length
		? ''
		: `AND (phase = '' OR phase IN (${selectedPhases.map(() => '?').join(',')}))`;
	const phaseArgs = selectedPhases.length === ALL_PHASES.length ? [] : selectedPhases;

	const rows = db.prepare(
		`SELECT metric_name, timestamp, value, unit FROM cloudwatch_datapoints WHERE run_id = ? AND metric_name LIKE 'os_%' ${phaseClause} ORDER BY metric_name, timestamp`
	).all(runId, ...phaseArgs) as Array<{ metric_name: string; timestamp: string; value: number; unit: string }>;

	if (rows.length === 0) return noData;

	const byMetric = new Map<string, Array<{ timestamp: string; value: number; unit: string }>>();
	for (const row of rows) {
		const bucket = byMetric.get(row.metric_name) ?? [];
		bucket.push({ timestamp: row.timestamp, value: row.value, unit: row.unit });
		byMetric.set(row.metric_name, bucket);
	}

	const buildGroup = (
		key: string,
		label: string,
		title: string,
		metrics: string[],
		kind: TelemetryValueKind = 'count'
	): TelemetryChartMetric | null => {
		const series: TelemetrySeries[] = [];
		let colorIdx = 0;
		for (const metricName of metrics) {
			const pts = byMetric.get(metricName);
			if (!pts || pts.length === 0) continue;
			const points = pts
				.map((p) => {
					const tsMs = toMs(p.timestamp);
					if (tsMs === null) return null;
					return { t: tsMs - runStartMs, v: p.value } as TelemetrySeriesPoint;
				})
				.filter((p): p is TelemetrySeriesPoint => p !== null);
			if (points.length > 0) {
				series.push({ label: metricName, color: COLORS[colorIdx % COLORS.length], points });
				colorIdx++;
			}
		}
		if (series.length === 0) return null;
		return { key, label, kind, title, series };
	};

	// Discover dynamic device names from metric names like os_disk_read_kbs_sda
	const allMetricNames = [...byMetric.keys()];
	const diskDevices = [...new Set(
		allMetricNames
			.filter((n) => n.startsWith('os_disk_read_kbs_'))
			.map((n) => n.replace('os_disk_read_kbs_', ''))
	)];

	const cpuGroup = buildGroup('os_cpu', 'CPU', 'CPU (%)',
		['os_cpu_usr', 'os_cpu_sys', 'os_cpu_iowait', 'os_cpu_steal', 'os_cpu_idle'], 'percent');
	const memGroup = buildGroup('os_mem', 'Memory', 'Memory (KB)',
		['os_mem_free_kb', 'os_mem_swapped_kb'], 'bytes');
	const diskGroups = diskDevices.map((dev) =>
		buildGroup(`os_disk_${dev}`, `Disk ${dev}`, `Disk ${dev}`,
			[`os_disk_read_kbs_${dev}`, `os_disk_write_kbs_${dev}`, `os_disk_util_pct_${dev}`])
	);
	const netGroup = buildGroup('os_net', 'Network', 'Network (KB/s)',
		allMetricNames.filter((n) => n.startsWith('os_net_')));

	const chartMetrics = [cpuGroup, memGroup, ...diskGroups, netGroup].filter((g): g is TelemetryChartMetric => g !== null);

	// Summary cards
	const cpuIoWaitPts = byMetric.get('os_cpu_iowait');
	const memFreePts = byMetric.get('os_mem_free_kb');
	const summary: TelemetryCard[] = [
		...(cpuIoWaitPts && cpuIoWaitPts.length > 0
			? [metricCard('os_cpu_iowait_peak', 'Peak IO Wait', 'percent', Math.max(...cpuIoWaitPts.map((p) => p.value)) / 100)]
			: []),
		...(memFreePts && memFreePts.length > 0
			? [metricCard('os_mem_free_min', 'Min Free Mem', 'bytes', Math.min(...memFreePts.map((p) => p.value)) * 1024)]
			: [])
	];

	const tableRows = [...byMetric.entries()].map(([name, pts]) => ({
		metric: name,
		value: pts[pts.length - 1]?.value ?? null,
		unit: pts[pts.length - 1]?.unit ?? '',
		samples: pts.length,
		value_kind: 'count' as const
	}));
	const tableSnapshots: TelemetryTableSnapshot[] = [...new Set(rows.map((row) => row.timestamp))]
		.sort((a, b) => a.localeCompare(b))
		.map((timestamp) => {
			const tMs = toMs(timestamp);
			if (tMs === null) return null;
			const rowsAtTime = [...byMetric.entries()]
				.map(([name, pts]) => {
					const point = pts.find((entry) => entry.timestamp === timestamp);
					if (!point) return null;
					return { metric: name, value: point.value, unit: point.unit ?? '', samples: pts.length, value_kind: 'count' as const };
				})
				.filter((row): row is NonNullable<typeof row> => row !== null);
			if (rowsAtTime.length === 0) return null;
			return { t: tMs - runStartMs, rows: rowsAtTime };
		})
		.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);

	return {
		key: 'os_metrics',
		label: 'SSH Metrics',
		status: 'ok',
		summary,
		chartTitle: 'OS metrics (via SSH)',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
		tableTitle: 'OS metrics (last value per metric)',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Last Value', kind: 'count' },
			{ key: 'unit', label: 'Unit', kind: 'text' },
			{ key: 'samples', label: 'Data Points', kind: 'count' }
		],
		tableRows,
		tableSnapshots
	};
}

function buildCloudWatchSection(db: Database.Database, runId: number, runStartMs: number, selectedPhases: TelemetryPhase[]): TelemetrySection {
	const noData: TelemetrySection = {
		key: 'cloudwatch',
		label: 'CloudWatch',
		status: 'no_data',
		reason: 'No CloudWatch metrics were collected for this run. Requires AWS region and RDS instance ID configured on the PostgreSQL server, and an IAM role with CloudWatchReadOnlyAccess on the EC2 instance.',
		summary: [],
		chartTitle: 'CloudWatch RDS metrics',
		chartSeries: [],
		tableTitle: 'CloudWatch metrics',
		tableColumns: [],
		tableRows: [],
		tableSnapshots: []
	};

	if (!tableExists(db, 'cloudwatch_datapoints')) return noData;

	// Filter by selected phases ('' = old data without phase tag, always include).
	const phaseClause = selectedPhases.length === ALL_PHASES.length
		? ''
		: `AND (phase = '' OR phase IN (${selectedPhases.map(() => '?').join(',')}))`;
	const phaseArgs = selectedPhases.length === ALL_PHASES.length ? [] : selectedPhases;

	const rows = db.prepare(
		`SELECT metric_name, timestamp, value, unit FROM cloudwatch_datapoints WHERE run_id = ? ${phaseClause} ORDER BY metric_name, timestamp`
	).all(runId, ...phaseArgs) as Array<{ metric_name: string; timestamp: string; value: number; unit: string }>;

	if (rows.length === 0) return noData;

	// Group by metric_name
	const byMetric = new Map<string, Array<{ timestamp: string; value: number; unit: string }>>();
	for (const row of rows) {
		const bucket = byMetric.get(row.metric_name) ?? [];
		bucket.push({ timestamp: row.timestamp, value: row.value, unit: row.unit });
		byMetric.set(row.metric_name, bucket);
	}

	// Helper: build a TelemetryChartMetric from a list of metric names (skips missing ones)
	const buildGroup = (
		key: string,
		label: string,
		title: string,
		metrics: string[],
		kind: TelemetryValueKind = 'count'
	): TelemetryChartMetric | null => {
		const series: TelemetrySeries[] = [];
		let colorIdx = 0;
		for (const metricName of metrics) {
			const pts = byMetric.get(metricName);
			if (!pts || pts.length === 0) continue;
			const points = pts
				.map((p) => {
					const tsMs = toMs(p.timestamp);
					if (tsMs === null) return null;
					return { t: tsMs - runStartMs, v: p.value } as TelemetrySeriesPoint;
				})
				.filter((p): p is TelemetrySeriesPoint => p !== null);
			if (points.length > 0) {
				series.push({ label: metricName, color: COLORS[colorIdx % COLORS.length], points });
				colorIdx++;
			}
		}
		if (series.length === 0) return null;
		return { key, label, kind, title, series };
	};

	// Basic CloudWatch metric groups
	const staticGroups = [
		buildGroup('cpu_memory', 'CPU & Memory', 'CPU & Memory', ['CPUUtilization', 'FreeableMemory', 'SwapUsage', 'DatabaseConnections']),
		buildGroup('iops', 'IOPS', 'IOPS', ['ReadIOPS', 'WriteIOPS', 'DiskQueueDepth']),
		buildGroup('latency', 'Latency', 'Latency', ['ReadLatency', 'WriteLatency']),
		buildGroup('throughput', 'Throughput', 'Throughput', ['ReadThroughput', 'WriteThroughput', 'NetworkReceiveThroughput', 'NetworkTransmitThroughput']),
		buildGroup('storage', 'Storage', 'Storage', ['FreeStorageSpace'])
	];

	// Enhanced Monitoring groups — static metrics
	const emCpuGroup = buildGroup('em_cpu', 'EM CPU Breakdown', 'EM CPU Breakdown (%)',
		['em_cpu_total', 'em_cpu_user', 'em_cpu_system', 'em_cpu_wait', 'em_cpu_steal', 'em_cpu_nice'], 'percent');
	const emLoadGroup = buildGroup('em_load', 'EM Load Average', 'EM Load Average',
		['em_load_1m', 'em_load_5m', 'em_load_15m']);
	const emMemGroup = buildGroup('em_memory', 'EM Memory', 'EM Memory (bytes)',
		['em_memory_total', 'em_memory_free', 'em_memory_cached', 'em_memory_active', 'em_memory_buffers', 'em_memory_dirty'], 'bytes');

	// Enhanced Monitoring — discover dynamic device/interface/filesystem names
	const allMetricNames = [...byMetric.keys()];

	const diskDevices = [...new Set(
		allMetricNames
			.filter((n) => n.startsWith('em_disk_') && n.endsWith('_util'))
			.map((n) => n.replace(/^em_disk_/, '').replace(/_util$/, ''))
	)];
	const emDiskGroups = diskDevices.map((dev) =>
		buildGroup(
			`em_disk_${dev}`,
			`EM Disk ${dev}`,
			`EM Disk ${dev}`,
			[
				`em_disk_${dev}_read_kbps`,
				`em_disk_${dev}_write_kbps`,
				`em_disk_${dev}_read_iops`,
				`em_disk_${dev}_write_iops`,
				`em_disk_${dev}_await`,
				`em_disk_${dev}_util`,
				`em_disk_${dev}_queue_len`
			]
		)
	);

	const netIfaces = [...new Set(
		allMetricNames
			.filter((n) => n.startsWith('em_net_') && n.endsWith('_rx'))
			.map((n) => n.replace(/^em_net_/, '').replace(/_rx$/, ''))
	)];
	const emNetGroup = netIfaces.length > 0
		? buildGroup('em_net', 'EM Network', 'EM Network (KB/s)',
			netIfaces.flatMap((iface) => [`em_net_${iface}_rx`, `em_net_${iface}_tx`]))
		: null;

	const fsNames = [...new Set(
		allMetricNames
			.filter((n) => n.startsWith('em_fs_') && n.endsWith('_used_pct'))
			.map((n) => n.replace(/^em_fs_/, '').replace(/_used_pct$/, ''))
	)];
	const emFsGroup = fsNames.length > 0
		? buildGroup('em_fs', 'EM Filesystem', 'EM Filesystem Usage (%)',
			fsNames.map((name) => `em_fs_${name}_used_pct`), 'percent')
		: null;

	const chartMetrics = prioritizeItems([
		...staticGroups,
		emCpuGroup,
		emLoadGroup,
		emMemGroup,
		...emDiskGroups,
		emNetGroup,
		emFsGroup
	].filter((g): g is TelemetryChartMetric => g !== null), (metric) => metric.label.startsWith('EM '));

	// Summary cards
	const cpuPts = byMetric.get('CPUUtilization') ?? byMetric.get('em_cpu_total');
	const memPts = byMetric.get('FreeableMemory');
	const connPts = byMetric.get('DatabaseConnections');
	const emMemFreePts = byMetric.get('em_memory_free');
	const emCpuWaitPts = byMetric.get('em_cpu_wait');
	const summary = prioritizeItems([
		metricCard('cw_cpu_peak', 'Peak CPU', 'percent', cpuPts && cpuPts.length > 0 ? Math.max(...cpuPts.map((p) => p.value)) / 100 : null),
		metricCard('cw_mem_min', 'Min Free Memory', 'bytes', memPts && memPts.length > 0 ? Math.min(...memPts.map((p) => p.value)) : null),
		metricCard('cw_conn_peak', 'Peak Connections', 'count', connPts && connPts.length > 0 ? Math.max(...connPts.map((p) => p.value)) : null),
		...(emMemFreePts && emMemFreePts.length > 0
			? [metricCard('em_mem_free_min', 'EM Min Free Mem', 'bytes', Math.min(...emMemFreePts.map((p) => p.value)))]
			: []),
		...(emCpuWaitPts && emCpuWaitPts.length > 0
			? [metricCard('em_cpu_wait_peak', 'EM Peak IO Wait', 'percent', Math.max(...emCpuWaitPts.map((p) => p.value)) / 100)]
			: [])
	], (card) => card.label.startsWith('EM '));

	// Table: last value per metric
	const tableRows = prioritizeItems([...byMetric.entries()].map(([name, pts]) => ({
		metric: name,
		value: pts[pts.length - 1]?.value ?? null,
		unit: pts[pts.length - 1]?.unit ?? '',
		samples: pts.length,
		value_kind: 'count' as const
	})), (row) => String(row.metric).startsWith('em_'));
	const tableSnapshots: TelemetryTableSnapshot[] = [...new Set(rows.map((row) => row.timestamp))]
		.sort((a, b) => a.localeCompare(b))
		.map((timestamp) => {
			const tMs = toMs(timestamp);
			if (tMs === null) return null;
			const rowsAtTime: Record<string, unknown>[] = prioritizeItems([...byMetric.entries()]
				.map(([name, pts]) => {
					const point = pts.find((entry) => entry.timestamp === timestamp);
					if (!point) return null;
					return {
						metric: name,
						value: point.value,
						unit: point.unit ?? '',
						samples: pts.length,
						value_kind: 'count' as const
					};
				})
				.filter((row): row is NonNullable<typeof row> => row !== null), (row) => String(row.metric).startsWith('em_'));
			if (rowsAtTime.length === 0) return null;
			return { t: tMs - runStartMs, rows: rowsAtTime };
		})
		.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);

	return {
		key: 'cloudwatch',
		label: 'CloudWatch',
		status: 'ok',
		summary,
		chartTitle: 'CloudWatch RDS metrics',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
		tableTitle: 'CloudWatch metrics (last value per metric)',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Last Value', kind: 'count' },
			{ key: 'unit', label: 'Unit', kind: 'text' },
			{ key: 'samples', label: 'Data Points', kind: 'count' }
		],
		tableRows,
		tableSnapshots
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
	const walRows = fetchRows(db, 'snap_pg_stat_wal', runId, selectedPhases);
	const bgwriterRows = fetchRows(db, 'snap_pg_stat_bgwriter', runId, selectedPhases);
	const checkpointerRows = fetchRows(db, 'snap_pg_stat_checkpointer', runId, selectedPhases);
	const archiverRows = fetchRows(db, 'snap_pg_stat_archiver', runId, selectedPhases);
	const ioRows = fetchRows(db, 'snap_pg_stat_io', runId, selectedPhases);
	const userTableRows = fetchRows(db, 'snap_pg_stat_user_tables', runId, selectedPhases);
	const userIndexRows = fetchRows(db, 'snap_pg_stat_user_indexes', runId, selectedPhases);
	const statioUserTableRows = fetchRows(db, 'snap_pg_statio_user_tables', runId, selectedPhases);
	const statioUserIndexRows = fetchRows(db, 'snap_pg_statio_user_indexes', runId, selectedPhases);
	const statioUserSequenceRows = fetchRows(db, 'snap_pg_statio_user_sequences', runId, selectedPhases);

	const databaseSection = buildDatabaseSection(databaseRows, runStartMs);
	const walSection = buildWalSection(walRows, runStartMs, toNumber(databaseSection.summary.find((card) => card.key === 'transactions')?.value));
	const sections: TelemetrySection[] = [
		databaseSection,
		walSection,
		buildBgwriterSection(bgwriterRows, runStartMs),
		buildCheckpointerSection(checkpointerRows, runStartMs),
		buildArchiverSection(archiverRows, runStartMs),
		buildIoSection(ioRows, runStartMs),
		buildUserTablesSection(userTableRows, runStartMs),
		buildUserIndexesSection(userIndexRows, runStartMs),
		buildStatioUserTablesSection(statioUserTableRows, runStartMs),
		buildStatioUserIndexesSection(statioUserIndexRows, runStartMs),
		buildStatioUserSequencesSection(statioUserSequenceRows, runStartMs),
		buildOsMetricsSection(db, runId, runStartMs, selectedPhases),
		buildCloudWatchSection(db, runId, runStartMs, selectedPhases)
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
		metricCard('temp_bytes_per_tx', 'Temp / Tx', 'bytes', (() => {
			const tmp = toNumber(databaseSection.summary.find((card) => card.key === 'temp_bytes')?.value);
			const tx = toNumber(databaseSection.summary.find((card) => card.key === 'transactions')?.value);
			return tmp !== null && tx !== null && tx > 0 ? tmp / tx : null;
		})()),
		metricCard('requested_checkpoints', 'Requested Checkpoints', 'count', sections.find((section) => section.key === 'checkpointer')?.summary.find((card) => card.key === 'num_requested')?.value ?? null),
		metricCard('dead_tuple_growth', 'Dead Tuple Growth', 'count', sections.find((section) => section.key === 'user_tables')?.summary.find((card) => card.key === 'dead_tuple_growth')?.value ?? null),
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
