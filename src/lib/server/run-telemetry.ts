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
	description?: string;
	color: string;
	points: TelemetrySeriesPoint[];
}

export interface TelemetryChartMetric {
	key: string;
	label: string;
	description?: string;
	kind: TelemetryValueKind;
	title: string;
	series: TelemetrySeries[];
	rawSeries?: TelemetrySeries[];
	allSeries?: TelemetrySeries[];
	allRawSeries?: TelemetrySeries[];
	group?: string;
	entity?: string;
	category?: 'raw' | 'derived';
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
	temp_files:
		'Temporary files created during the selected phases. Higher values often mean sorts or hashes spilled to disk.',
	temp_bytes_per_tx:
		'Average temporary-file bytes per transaction: temp_bytes divided by total transactions. Higher values often indicate spills from sorts or hashes.',
	session_time:
		'Total database session time reported by pg_stat_database during the selected phases.',
	active_time:
		'Total time database sessions spent executing queries during the selected phases.',
	idle_in_transaction_time:
		'Total time database sessions spent idle while inside a transaction during the selected phases.',
	parallel_workers_to_launch:
		'Parallel workers PostgreSQL wanted to launch during the selected phases.',
	parallel_workers_launched:
		'Parallel workers PostgreSQL actually launched during the selected phases.',
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

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
	if (!tableExists(db, tableName)) return false;
	return (db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[])
		.some((column) => column.name === columnName);
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
	metrics: Array<{ label: string; description?: string; valueFn: (row: SnapshotRow) => number | null }>
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
			const series: TelemetrySeries = { label: metric.label, color: COLORS[index % COLORS.length], points };
			if (metric.description) series.description = metric.description;
			return series;
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
// delta-based ratios (e.g. cache hit rate = delta hit / (delta hit + delta read)) at each snapshot.
function buildDerivedSeries(
	rows: SnapshotRow[],
	runStartMs: number,
	metrics: Array<{ label: string; description?: string; seriesValueAt: (rows: SnapshotRow[], index: number) => number | null }>,
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
			const series: TelemetrySeries = { label: metric.label, color: COLORS[(colorOffset + index) % COLORS.length], points };
			if (metric.description) series.description = metric.description;
			return series;
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
		description?: string;
		kind: TelemetryValueKind;
		title: string;
		group?: string;
		category?: 'raw' | 'derived';
		scoreFn: (entry: T) => number | null;
		seriesValueAt: (rows: SnapshotRow[], index: number) => number | null;
		rawSeriesValueAt?: (rows: SnapshotRow[], index: number) => number | null;
	}>,
	limit = 5
): TelemetryChartMetric[] {
	return metrics
		.map((metric) => {
			const top = topEntries(entries, metric.scoreFn, limit);
			const topEntryObjs = top.map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows }));
			const series = buildGroupedSeries(topEntryObjs, runStartMs, metric.seriesValueAt);
			if (series.length === 0) return null;
			const rawSeries = metric.rawSeriesValueAt
				? buildGroupedSeries(topEntryObjs, runStartMs, metric.rawSeriesValueAt)
				: undefined;
			const hasMore = entries.length > top.length;
			let allSeries: TelemetrySeries[] | undefined;
			let allRawSeries: TelemetrySeries[] | undefined;
			if (hasMore) {
				const allEntryObjs = topEntries(entries, metric.scoreFn, entries.length).map((entry) => ({ key: entry.key, label: entry.label, rows: entry.rows }));
				allSeries = buildGroupedSeries(allEntryObjs, runStartMs, metric.seriesValueAt);
				if (metric.rawSeriesValueAt) {
					allRawSeries = buildGroupedSeries(allEntryObjs, runStartMs, metric.rawSeriesValueAt);
				}
			}
			return {
				key: metric.key,
				label: metric.label,
				description: metric.description,
				kind: metric.kind,
				title: metric.title,
				group: metric.group,
				category: metric.category,
				series,
				rawSeries: rawSeries?.length ? rawSeries : undefined,
				allSeries: allSeries?.length ? allSeries : undefined,
				allRawSeries: allRawSeries?.length ? allRawSeries : undefined
			} as TelemetryChartMetric;
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
		.filter((item) => (scoreFn(item) ?? 0) > 0)
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
	const blocksRead = delta(rows, 'blks_read');
	const blocksHit = delta(rows, 'blks_hit');
	const totalBlockAccess = sum([blocksRead, blocksHit]);
	const hitRatio = safeRatio(blocksHit, totalBlockAccess);
	const missRatio = safeRatio(blocksRead, totalBlockAccess);
	const rowsReturned = delta(rows, 'tup_returned');
	const rowsFetched = delta(rows, 'tup_fetched');
	const rowsInserted = delta(rows, 'tup_inserted');
	const rowsUpdated = delta(rows, 'tup_updated');
	const rowsDeleted = delta(rows, 'tup_deleted');
	const rowsWritten = sum([rowsInserted, rowsUpdated, rowsDeleted]);
	const totalRowActivity = sum([rowsReturned, rowsFetched, rowsWritten]);
	const tempBytes = delta(rows, 'temp_bytes');
	const tempFiles = delta(rows, 'temp_files');
	const sessions = delta(rows, 'sessions');
	const sessionsAbandoned = delta(rows, 'sessions_abandoned');
	const sessionsFatal = delta(rows, 'sessions_fatal');
	const sessionsKilled = delta(rows, 'sessions_killed');
	const sessionTime = delta(rows, 'session_time');
	const activeTime = delta(rows, 'active_time');
	const idleInTransactionTime = delta(rows, 'idle_in_transaction_time');
	const parallelWorkersToLaunch = delta(rows, 'parallel_workers_to_launch');
	const parallelWorkersLaunched = delta(rows, 'parallel_workers_launched');
	const blockReadTime = delta(rows, 'blk_read_time');
	const blockWriteTime = delta(rows, 'blk_write_time');
	const blockIoTime = sum([blockReadTime, blockWriteTime]);
	const deadlocks = delta(rows, 'deadlocks');
	const tps = safeRatio(totalTransactions, elapsedSeconds(rows));
	const diskReadsPerTx = safeRatio(blocksRead, totalTransactions);
	const blockAccessPerTx = safeRatio(totalBlockAccess, totalTransactions);
	const blockReadMsPerBlock = safeRatio(blockReadTime, blocksRead);
	const ioActiveRatio = safeRatio(blockIoTime, activeTime);
	const rowsReturnedPerTx = safeRatio(rowsReturned, totalTransactions);
	const rowsFetchedPerTx = safeRatio(rowsFetched, totalTransactions);
	const rowsWrittenPerTx = safeRatio(rowsWritten, totalTransactions);
	const returnedFetchedRatio = safeRatio(rowsReturned, rowsFetched);
	const writeMix = safeRatio(rowsWritten, totalRowActivity);
	const tempBytesPerTx = safeRatio(tempBytes, totalTransactions);
	const tempFilesPerTx = safeRatio(tempFiles, totalTransactions);
	const avgTempFileSize = safeRatio(tempBytes, tempFiles);
	const activeTimePerTx = safeRatio(activeTime, totalTransactions);
	const sessionTimePerTx = safeRatio(sessionTime, totalTransactions);
	const idleInTransactionTimePerTx = safeRatio(idleInTransactionTime, totalTransactions);
	const parallelLaunchSuccess = safeRatio(parallelWorkersLaunched, parallelWorkersToLaunch);
	const parallelWorkersPerTx = safeRatio(parallelWorkersLaunched, totalTransactions);
	const deadlocksPerMillionTx = (() => {
		const value = safeRatio(deadlocks, totalTransactions);
		return value === null ? null : value * 1_000_000;
	})();

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

	const dbChartMetrics: TelemetryChartMetric[] = [];
	const DB_GROUP = {
		workload: 'Workload Shape',
		io: 'I/O Pressure',
		spills: 'Spills',
		session: 'Session Behavior',
		parallel: 'Parallelism',
		errors: 'Errors'
	} as const;
	const PG_STAT_DATABASE_DOCS = {
		xact_commit: 'Transactions in this database that committed.',
		xact_rollback: 'Transactions in this database that rolled back.',
		blks_read: 'Disk blocks read in this database.',
		blks_hit: 'Disk blocks found already in the PostgreSQL buffer cache, so no read was needed.',
		tup_returned: 'Live rows fetched by sequential scans and index entries returned by index scans in this database.',
		tup_fetched: 'Live rows fetched by index scans in this database.',
		tup_inserted: 'Rows inserted by queries in this database.',
		tup_updated: 'Rows updated by queries in this database.',
		tup_deleted: 'Rows deleted by queries in this database.',
		temp_files: 'Temporary files created by queries in this database, regardless of why the file was created.',
		temp_bytes: 'Data written to temporary files by queries in this database.',
		deadlocks: 'Deadlocks detected in this database.',
		blk_read_time: 'Time spent reading data file blocks by backends in this database, in milliseconds.',
		blk_write_time: 'Time spent writing data file blocks by backends in this database, in milliseconds.',
		sessions: 'Total sessions established to this database.',
		sessions_abandoned: 'Database sessions to this database that were terminated because connection to the client was lost.',
		sessions_fatal: 'Database sessions to this database that were terminated by fatal errors.',
		sessions_killed: 'Database sessions to this database that were terminated by operator intervention.',
		session_time: 'Time spent by database sessions in this database, in milliseconds.',
		active_time: 'Time spent executing SQL statements in this database, in milliseconds.',
		idle_in_transaction_time: 'Time spent idling while in a transaction in this database, in milliseconds.',
		parallel_workers_to_launch: 'Parallel workers planned to be launched by queries on this database.',
		parallel_workers_launched: 'Parallel workers launched by queries on this database.'
	} as const;
	const pgStatSource = (columns: string[]) => `Source: pg_stat_database.${columns.join(', pg_stat_database.')}.`;
	const rateDescription = (description: string, columns: string[]) => `${description} Shown as a per second delta. ${pgStatSource(columns)}`;
	const rawDescription = (description: string, columns: string[]) => `${description} Cumulative raw view shows the delta since the first selected sample. ${pgStatSource(columns)}`;
	const push = (m: TelemetryChartMetric | null, group: string) => {
		if (m && (m.series.length > 0 || (m.rawSeries?.length ?? 0) > 0)) dbChartMetrics.push({ ...m, group });
	};

	// RAW metrics — series = rate/s, rawSeries = cumulative delta
	const txRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'total/s', description: rateDescription('Committed plus rolled-back transactions in this database.', ['xact_commit', 'xact_rollback']), seriesValueAt: (r, i) => safeRatio(sumDeltaAt(r, i, ['xact_commit', 'xact_rollback']), elapsedSecondsAt(r, i)) },
		{ label: 'commits/s', description: rateDescription(PG_STAT_DATABASE_DOCS.xact_commit, ['xact_commit']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'xact_commit'), elapsedSecondsAt(r, i)) },
		{ label: 'rollbacks/s', description: rateDescription(PG_STAT_DATABASE_DOCS.xact_rollback, ['xact_rollback']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'xact_rollback'), elapsedSecondsAt(r, i)) }
	]);
	const txRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'transactions', description: rawDescription('Committed plus rolled-back transactions in this database.', ['xact_commit', 'xact_rollback']), valueFn: (row) => sum([toNumber(row.xact_commit), toNumber(row.xact_rollback)]) },
		{ label: 'commits', description: rawDescription(PG_STAT_DATABASE_DOCS.xact_commit, ['xact_commit']), valueFn: (row) => toNumber(row.xact_commit) },
		{ label: 'rollbacks', description: rawDescription(PG_STAT_DATABASE_DOCS.xact_rollback, ['xact_rollback']), valueFn: (row) => toNumber(row.xact_rollback) }
	]);
	push({ key: 'transactions', label: 'Transactions', kind: 'tps', title: 'Transaction rate over time', category: 'raw', series: txRate, rawSeries: txRaw }, DB_GROUP.workload);

	const blockRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'hits/s', description: rateDescription(PG_STAT_DATABASE_DOCS.blks_hit, ['blks_hit']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'blks_hit'), elapsedSecondsAt(r, i)) },
		{ label: 'reads/s', description: rateDescription(PG_STAT_DATABASE_DOCS.blks_read, ['blks_read']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'blks_read'), elapsedSecondsAt(r, i)) }
	]);
	const blockRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'blocks hit', description: rawDescription(PG_STAT_DATABASE_DOCS.blks_hit, ['blks_hit']), valueFn: (row) => toNumber(row.blks_hit) },
		{ label: 'blocks read', description: rawDescription(PG_STAT_DATABASE_DOCS.blks_read, ['blks_read']), valueFn: (row) => toNumber(row.blks_read) }
	]);
	push({ key: 'block_access', label: 'Block Access', kind: 'count', title: 'Block access over time', category: 'raw', series: blockRate, rawSeries: blockRaw }, DB_GROUP.io);

	const rowWriteRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'inserts/s', description: rateDescription(PG_STAT_DATABASE_DOCS.tup_inserted, ['tup_inserted']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_inserted'), elapsedSecondsAt(r, i)) },
		{ label: 'updates/s', description: rateDescription(PG_STAT_DATABASE_DOCS.tup_updated, ['tup_updated']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_updated'), elapsedSecondsAt(r, i)) },
		{ label: 'deletes/s', description: rateDescription(PG_STAT_DATABASE_DOCS.tup_deleted, ['tup_deleted']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_deleted'), elapsedSecondsAt(r, i)) }
	]);
	const rowWriteRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'rows inserted', description: rawDescription(PG_STAT_DATABASE_DOCS.tup_inserted, ['tup_inserted']), valueFn: (row) => toNumber(row.tup_inserted) },
		{ label: 'rows updated', description: rawDescription(PG_STAT_DATABASE_DOCS.tup_updated, ['tup_updated']), valueFn: (row) => toNumber(row.tup_updated) },
		{ label: 'rows deleted', description: rawDescription(PG_STAT_DATABASE_DOCS.tup_deleted, ['tup_deleted']), valueFn: (row) => toNumber(row.tup_deleted) }
	]);
	push({ key: 'row_writes', label: 'Row Writes', kind: 'count', title: 'Row write activity', category: 'raw', series: rowWriteRate, rawSeries: rowWriteRaw }, DB_GROUP.workload);

	const rowReadRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'returned/s', description: rateDescription(PG_STAT_DATABASE_DOCS.tup_returned, ['tup_returned']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_returned'), elapsedSecondsAt(r, i)) },
		{ label: 'fetched/s', description: rateDescription(PG_STAT_DATABASE_DOCS.tup_fetched, ['tup_fetched']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_fetched'), elapsedSecondsAt(r, i)) }
	]);
	const rowReadRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'rows returned', description: rawDescription(PG_STAT_DATABASE_DOCS.tup_returned, ['tup_returned']), valueFn: (row) => toNumber(row.tup_returned) },
		{ label: 'rows fetched', description: rawDescription(PG_STAT_DATABASE_DOCS.tup_fetched, ['tup_fetched']), valueFn: (row) => toNumber(row.tup_fetched) }
	]);
	push({ key: 'row_reads', label: 'Row Reads', kind: 'count', title: 'Row read activity', category: 'raw', series: rowReadRate, rawSeries: rowReadRaw }, DB_GROUP.workload);

	const tempBytesRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'temp bytes/s', description: rateDescription(PG_STAT_DATABASE_DOCS.temp_bytes, ['temp_bytes']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'temp_bytes'), elapsedSecondsAt(r, i)) }
	]);
	const tempBytesRaw = buildMetricSeries(rows, runStartMs, [{ label: 'temp bytes', description: rawDescription(PG_STAT_DATABASE_DOCS.temp_bytes, ['temp_bytes']), valueFn: (row) => toNumber(row.temp_bytes) }]);
	push({ key: 'temp_usage', label: 'Temp Usage', kind: 'bytes', title: 'Temp bytes over time', category: 'raw', series: tempBytesRate, rawSeries: tempBytesRaw }, DB_GROUP.spills);

	const tempFilesRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'temp files/s', description: rateDescription(PG_STAT_DATABASE_DOCS.temp_files, ['temp_files']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'temp_files'), elapsedSecondsAt(r, i)) }
	]);
	const tempFilesRaw = buildMetricSeries(rows, runStartMs, [{ label: 'temp files', description: rawDescription(PG_STAT_DATABASE_DOCS.temp_files, ['temp_files']), valueFn: (row) => toNumber(row.temp_files) }]);
	push({ key: 'temp_files', label: 'Temp Files', kind: 'count', title: 'Temp files over time', category: 'raw', series: tempFilesRate, rawSeries: tempFilesRaw }, DB_GROUP.spills);

	const deadlockRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'deadlocks/s', description: rateDescription(PG_STAT_DATABASE_DOCS.deadlocks, ['deadlocks']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'deadlocks'), elapsedSecondsAt(r, i)) }
	]);
	const deadlockRaw = buildMetricSeries(rows, runStartMs, [{ label: 'deadlocks', description: rawDescription(PG_STAT_DATABASE_DOCS.deadlocks, ['deadlocks']), valueFn: (row) => toNumber(row.deadlocks) }]);
	push({ key: 'deadlocks', label: 'Deadlocks', kind: 'count', title: 'Deadlocks over time', category: 'raw', series: deadlockRate, rawSeries: deadlockRaw }, DB_GROUP.errors);

	const blockIoTimeRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'block read time/s', description: rateDescription(PG_STAT_DATABASE_DOCS.blk_read_time, ['blk_read_time']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'blk_read_time'), elapsedSecondsAt(r, i)) },
		{ label: 'block write time/s', description: rateDescription(PG_STAT_DATABASE_DOCS.blk_write_time, ['blk_write_time']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'blk_write_time'), elapsedSecondsAt(r, i)) }
	]);
	const blockIoTimeRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'block read time', description: rawDescription(PG_STAT_DATABASE_DOCS.blk_read_time, ['blk_read_time']), valueFn: (row) => toNumber(row.blk_read_time) },
		{ label: 'block write time', description: rawDescription(PG_STAT_DATABASE_DOCS.blk_write_time, ['blk_write_time']), valueFn: (row) => toNumber(row.blk_write_time) }
	]);
	push({ key: 'block_io_time', label: 'Block I/O Time', kind: 'duration_ms', title: 'Block I/O time over time', category: 'raw', series: blockIoTimeRate, rawSeries: blockIoTimeRaw }, DB_GROUP.io);

	const sessionTimeRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'session time/s', description: rateDescription(PG_STAT_DATABASE_DOCS.session_time, ['session_time']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'session_time'), elapsedSecondsAt(r, i)) },
		{ label: 'active time/s', description: rateDescription(PG_STAT_DATABASE_DOCS.active_time, ['active_time']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'active_time'), elapsedSecondsAt(r, i)) },
		{ label: 'idle in transaction time/s', description: rateDescription(PG_STAT_DATABASE_DOCS.idle_in_transaction_time, ['idle_in_transaction_time']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'idle_in_transaction_time'), elapsedSecondsAt(r, i)) }
	]);
	const sessionTimeRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'session time', description: rawDescription(PG_STAT_DATABASE_DOCS.session_time, ['session_time']), valueFn: (row) => toNumber(row.session_time) },
		{ label: 'active time', description: rawDescription(PG_STAT_DATABASE_DOCS.active_time, ['active_time']), valueFn: (row) => toNumber(row.active_time) },
		{ label: 'idle in transaction time', description: rawDescription(PG_STAT_DATABASE_DOCS.idle_in_transaction_time, ['idle_in_transaction_time']), valueFn: (row) => toNumber(row.idle_in_transaction_time) }
	]);
	push({ key: 'session_time', label: 'Session Time', kind: 'duration_ms', title: 'Session time over time', category: 'raw', series: sessionTimeRate, rawSeries: sessionTimeRaw }, DB_GROUP.session);

	const sessionsRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'sessions/s', description: rateDescription(PG_STAT_DATABASE_DOCS.sessions, ['sessions']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sessions'), elapsedSecondsAt(r, i)) },
		{ label: 'abandoned/s', description: rateDescription(PG_STAT_DATABASE_DOCS.sessions_abandoned, ['sessions_abandoned']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sessions_abandoned'), elapsedSecondsAt(r, i)) },
		{ label: 'fatal/s', description: rateDescription(PG_STAT_DATABASE_DOCS.sessions_fatal, ['sessions_fatal']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sessions_fatal'), elapsedSecondsAt(r, i)) },
		{ label: 'killed/s', description: rateDescription(PG_STAT_DATABASE_DOCS.sessions_killed, ['sessions_killed']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sessions_killed'), elapsedSecondsAt(r, i)) }
	]);
	const sessionsRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'sessions', description: rawDescription(PG_STAT_DATABASE_DOCS.sessions, ['sessions']), valueFn: (row) => toNumber(row.sessions) },
		{ label: 'sessions abandoned', description: rawDescription(PG_STAT_DATABASE_DOCS.sessions_abandoned, ['sessions_abandoned']), valueFn: (row) => toNumber(row.sessions_abandoned) },
		{ label: 'sessions fatal', description: rawDescription(PG_STAT_DATABASE_DOCS.sessions_fatal, ['sessions_fatal']), valueFn: (row) => toNumber(row.sessions_fatal) },
		{ label: 'sessions killed', description: rawDescription(PG_STAT_DATABASE_DOCS.sessions_killed, ['sessions_killed']), valueFn: (row) => toNumber(row.sessions_killed) }
	]);
	push({ key: 'sessions', label: 'Sessions', kind: 'count', title: 'Session counts over time', category: 'raw', series: sessionsRate, rawSeries: sessionsRaw }, DB_GROUP.session);

	const parallelWorkersRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'workers to launch/s', description: rateDescription(PG_STAT_DATABASE_DOCS.parallel_workers_to_launch, ['parallel_workers_to_launch']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'parallel_workers_to_launch'), elapsedSecondsAt(r, i)) },
		{ label: 'workers launched/s', description: rateDescription(PG_STAT_DATABASE_DOCS.parallel_workers_launched, ['parallel_workers_launched']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'parallel_workers_launched'), elapsedSecondsAt(r, i)) }
	]);
	const parallelWorkersRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'workers to launch', description: rawDescription(PG_STAT_DATABASE_DOCS.parallel_workers_to_launch, ['parallel_workers_to_launch']), valueFn: (row) => toNumber(row.parallel_workers_to_launch) },
		{ label: 'workers launched', description: rawDescription(PG_STAT_DATABASE_DOCS.parallel_workers_launched, ['parallel_workers_launched']), valueFn: (row) => toNumber(row.parallel_workers_launched) }
	]);
	push({ key: 'parallel_workers', label: 'Parallel Workers', kind: 'count', title: 'Parallel worker usage over time', category: 'raw', series: parallelWorkersRate, rawSeries: parallelWorkersRaw }, DB_GROUP.parallel);

	// DERIVED metrics — computed ratios and per-unit values
	const cacheHitSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'cache hit rate', description: 'Share of block access served from shared buffers instead of disk. Uses: blks_hit / (blks_hit + blks_read).', seriesValueAt: (r, i) => ratioAt(r, i, 'blks_hit', ['blks_hit', 'blks_read']) }
	]);
	push({ key: 'cache_hit_rate', label: 'Cache Hit Rate', kind: 'percent', title: 'Buffer cache hit rate over time', category: 'derived', series: cacheHitSeries }, DB_GROUP.io);

	const cacheMissSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'cache miss rate', description: 'Share of block access that required disk reads; rising values point to cache pressure or cold data. Uses: blks_read / (blks_hit + blks_read).', seriesValueAt: (r, i) => ratioAt(r, i, 'blks_read', ['blks_hit', 'blks_read']) }
	]);
	push({ key: 'cache_miss_rate', label: 'Cache Miss Rate', kind: 'percent', title: 'Buffer cache miss rate over time', category: 'derived', series: cacheMissSeries }, DB_GROUP.io);

	const rollbackRateSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'rollback rate', description: 'Rollbacks as a share of all transactions; high values can indicate retries, conflicts, or application errors. Uses: xact_rollback / (xact_commit + xact_rollback).', seriesValueAt: (r, i) => ratioAt(r, i, 'xact_rollback', ['xact_commit', 'xact_rollback']) }
	]);
	push({ key: 'rollback_rate', label: 'Rollback Rate', kind: 'percent', title: 'Transaction rollback rate over time', category: 'derived', series: rollbackRateSeries }, DB_GROUP.errors);

	const blockReadMsSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'ms / block read', description: 'Average read latency per disk block read. Uses: blk_read_time / blks_read.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'blk_read_time'), deltaAt(r, i, 'blks_read')) }
	]);
	push({ key: 'block_read_ms', label: 'Block Read ms/block', kind: 'duration_ms', title: 'Avg block read time per block', category: 'derived', series: blockReadMsSeries }, DB_GROUP.io);

	const ioPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'disk reads / tx', description: 'Disk block reads per transaction; separates transaction volume from I/O intensity. Uses: blks_read / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'blks_read'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) },
		{ label: 'block access / tx', description: 'Shared-buffer hits plus disk reads per transaction; rough proxy for query footprint. Uses: (blks_read + blks_hit) / transactions.', seriesValueAt: (r, i) => safeRatio(sumDeltaAt(r, i, ['blks_read', 'blks_hit']), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) }
	]);
	push({ key: 'io_per_tx', label: 'I/O / Tx', kind: 'count', title: 'Block access per transaction', category: 'derived', series: ioPerTxSeries }, DB_GROUP.io);

	const ioActiveRatioSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'I/O time / active time', description: 'Block read plus write time as a share of active session time; high values suggest I/O-bound work. Uses: (blk_read_time + blk_write_time) / active_time.', seriesValueAt: (r, i) => safeRatio(sumDeltaAt(r, i, ['blk_read_time', 'blk_write_time']), deltaAt(r, i, 'active_time')) }
	]);
	push({ key: 'io_active_ratio', label: 'I/O / Active Time', kind: 'percent', title: 'Block I/O time as share of active session time', category: 'derived', series: ioActiveRatioSeries }, DB_GROUP.io);

	const activeBackendsSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'active backends', description: 'Current backend count from pg_stat_database; instantaneous, not a cumulative counter. Uses: numbackends.', seriesValueAt: (r, i) => toNumber(r[i].numbackends) }
	]);
	push({ key: 'active_backends', label: 'Active Backends', kind: 'count', title: 'Active backends (instantaneous)', category: 'derived', series: activeBackendsSeries }, DB_GROUP.session);

	const sessionRatioSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'active time ratio', description: 'Share of session time spent executing queries; low values can point to connection/client wait overhead. Uses: active_time / session_time.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'active_time'), deltaAt(r, i, 'session_time')) },
		{ label: 'idle in txn ratio', description: 'Share of session time spent idle while inside a transaction; high values point to client transaction-scope issues. Uses: idle_in_transaction_time / session_time.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'idle_in_transaction_time'), deltaAt(r, i, 'session_time')) },
		{ label: 'session error rate', description: 'Abandoned, fatal, or killed sessions divided by total sessions. Uses: (sessions_abandoned + sessions_fatal + sessions_killed) / sessions.', seriesValueAt: (r, i) => safeRatio(sum([deltaAt(r, i, 'sessions_abandoned'), deltaAt(r, i, 'sessions_fatal'), deltaAt(r, i, 'sessions_killed')]), deltaAt(r, i, 'sessions')) }
	]);
	push({ key: 'session_ratios', label: 'Session Ratios', kind: 'percent', title: 'Session time breakdown', category: 'derived', series: sessionRatioSeries }, DB_GROUP.session);

	const sessionPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'active time / tx', description: 'Database execution time per transaction; useful for comparing query cost across designs. Uses: active_time / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'active_time'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) },
		{ label: 'session time / tx', description: 'Total session time per transaction, including active and waiting/idle session time. Uses: session_time / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'session_time'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) },
		{ label: 'idle in txn time / tx', description: 'Idle-in-transaction time per transaction; highlights client-side transaction stalls. Uses: idle_in_transaction_time / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'idle_in_transaction_time'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) }
	]);
	push({ key: 'session_time_per_tx', label: 'Session Time / Tx', kind: 'duration_ms', title: 'Session time per transaction', category: 'derived', series: sessionPerTxSeries }, DB_GROUP.session);

	const rowsPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'rows returned / tx', description: 'Rows returned by queries per transaction; high values can mean broad scans or large result sets. Uses: tup_returned / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_returned'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) },
		{ label: 'rows fetched / tx', description: 'Rows fetched from tables per transaction; useful for comparing executor table access. Uses: tup_fetched / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_fetched'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) },
		{ label: 'rows written / tx', description: 'Inserted, updated, and deleted rows per transaction; separates write intensity from transaction count. Uses: (tup_inserted + tup_updated + tup_deleted) / transactions.', seriesValueAt: (r, i) => safeRatio(sumDeltaAt(r, i, ['tup_inserted', 'tup_updated', 'tup_deleted']), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) }
	]);
	push({ key: 'rows_per_tx', label: 'Rows / Tx', kind: 'count', title: 'Rows per transaction', category: 'derived', series: rowsPerTxSeries }, DB_GROUP.workload);

	const returnedFetchedSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'returned / fetched', description: 'Rows returned divided by rows fetched; high values can indicate broad scan-style query work. Uses: tup_returned / tup_fetched.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'tup_returned'), deltaAt(r, i, 'tup_fetched')) }
	]);
	push({ key: 'returned_fetched_ratio', label: 'Returned / Fetched', kind: 'count', title: 'Rows returned per fetched row', category: 'derived', series: returnedFetchedSeries }, DB_GROUP.workload);

	const writeMixSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'write mix', description: 'Writes as a share of row activity; helps distinguish read-heavy from write-heavy workload shape. Uses: row writes / (rows returned + rows fetched + row writes).', seriesValueAt: (r, i) => safeRatio(sumDeltaAt(r, i, ['tup_inserted', 'tup_updated', 'tup_deleted']), sum([deltaAt(r, i, 'tup_returned'), deltaAt(r, i, 'tup_fetched'), sumDeltaAt(r, i, ['tup_inserted', 'tup_updated', 'tup_deleted'])])) }
	]);
	push({ key: 'write_mix', label: 'Write Mix', kind: 'percent', title: 'Writes as a share of row activity', category: 'derived', series: writeMixSeries }, DB_GROUP.workload);

	const tempPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'temp bytes / tx', description: 'Temporary-file bytes per transaction; high values often indicate sort/hash spills. Uses: temp_bytes / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'temp_bytes'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) }
	]);
	push({ key: 'temp_bytes_per_tx', label: 'Temp Bytes / Tx', kind: 'bytes', title: 'Temporary bytes per transaction', category: 'derived', series: tempPerTxSeries }, DB_GROUP.spills);

	const tempFilesPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'temp files / tx', description: 'Temporary files created per transaction; many files can indicate repeated spill events. Uses: temp_files / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'temp_files'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) }
	]);
	push({ key: 'temp_files_per_tx', label: 'Temp Files / Tx', kind: 'count', title: 'Temporary files per transaction', category: 'derived', series: tempFilesPerTxSeries }, DB_GROUP.spills);

	const avgTempFileSizeSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'avg temp file size', description: 'Average bytes per temp file; separates a few large spills from many small spill files. Uses: temp_bytes / temp_files.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'temp_bytes'), deltaAt(r, i, 'temp_files')) }
	]);
	push({ key: 'avg_temp_file_size', label: 'Avg Temp File Size', kind: 'bytes', title: 'Average temporary file size', category: 'derived', series: avgTempFileSizeSeries }, DB_GROUP.spills);

	const parallelLaunchSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'launch success rate', description: 'Parallel workers launched divided by workers requested; low values suggest parallel worker pressure. Uses: parallel_workers_launched / parallel_workers_to_launch.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'parallel_workers_launched'), deltaAt(r, i, 'parallel_workers_to_launch')) }
	]);
	push({ key: 'parallel_launch_success', label: 'Parallel Launch Success', kind: 'percent', title: 'Parallel worker launch success rate', category: 'derived', series: parallelLaunchSeries }, DB_GROUP.parallel);

	const parallelWorkersPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'workers launched / tx', description: 'Parallel workers launched per transaction; shows whether parallel execution meaningfully participated. Uses: parallel_workers_launched / transactions.', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'parallel_workers_launched'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback'])) }
	]);
	push({ key: 'parallel_workers_per_tx', label: 'Parallel Workers / Tx', kind: 'count', title: 'Parallel workers launched per transaction', category: 'derived', series: parallelWorkersPerTxSeries }, DB_GROUP.parallel);

	const deadlocksPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'deadlocks / 1M tx', description: 'Deadlocks normalized per million transactions so runs of different sizes are comparable. Uses: deadlocks / transactions.', seriesValueAt: (r, i) => {
			const value = safeRatio(deltaAt(r, i, 'deadlocks'), sumDeltaAt(r, i, ['xact_commit', 'xact_rollback']));
			return value === null ? null : value * 1_000_000;
		} }
	]);
	push({ key: 'deadlocks_per_tx', label: 'Deadlocks / 1M Tx', kind: 'count', title: 'Deadlocks normalized by transaction volume', category: 'derived', series: deadlocksPerTxSeries }, DB_GROUP.errors);

	return {
		key: 'database',
		label: 'Database',
		status: 'ok',
		summary: [],
		chartTitle: dbChartMetrics[0]?.title ?? 'Database metrics over time',
		chartSeries: dbChartMetrics[0]?.series ?? [],
		chartMetrics: dbChartMetrics,
		defaultChartMetricKey: 'transactions',
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
			{ metric: 'Cache miss rate', value: missRatio, kind: 'percent' },
			{ metric: 'Blocks read', value: blocksRead, kind: 'count' },
			{ metric: 'Blocks hit', value: blocksHit, kind: 'count' },
			{ metric: 'Disk reads / tx', value: diskReadsPerTx, kind: 'count' },
			{ metric: 'Block access / tx', value: blockAccessPerTx, kind: 'count' },
			{ metric: 'Rows inserted', value: rowsInserted, kind: 'count' },
			{ metric: 'Rows updated', value: rowsUpdated, kind: 'count' },
			{ metric: 'Rows deleted', value: rowsDeleted, kind: 'count' },
			{ metric: 'Rows returned / tx', value: rowsReturnedPerTx, kind: 'count' },
			{ metric: 'Rows fetched / tx', value: rowsFetchedPerTx, kind: 'count' },
			{ metric: 'Rows written / tx', value: rowsWrittenPerTx, kind: 'count' },
			{ metric: 'Returned / fetched', value: returnedFetchedRatio, kind: 'count' },
			{ metric: 'Write mix', value: writeMix, kind: 'percent' },
			{ metric: 'Temp bytes', value: tempBytes, kind: 'bytes' },
			{ metric: 'Temp files', value: tempFiles, kind: 'count' },
			{ metric: 'Temp bytes / tx', value: tempBytesPerTx, kind: 'bytes' },
			{ metric: 'Temp files / tx', value: tempFilesPerTx, kind: 'count' },
			{ metric: 'Avg temp file size', value: avgTempFileSize, kind: 'bytes' },
			{ metric: 'Sessions', value: sessions, kind: 'count' },
			{ metric: 'Sessions abandoned', value: sessionsAbandoned, kind: 'count' },
			{ metric: 'Sessions fatal', value: sessionsFatal, kind: 'count' },
			{ metric: 'Sessions killed', value: sessionsKilled, kind: 'count' },
			{ metric: 'Session time (ms)', value: sessionTime, kind: 'duration_ms' },
			{ metric: 'Active time (ms)', value: activeTime, kind: 'duration_ms' },
			{ metric: 'Idle in transaction time (ms)', value: idleInTransactionTime, kind: 'duration_ms' },
			{ metric: 'I/O time / active time', value: ioActiveRatio, kind: 'percent' },
			{ metric: 'Active time / tx', value: activeTimePerTx, kind: 'duration_ms' },
			{ metric: 'Session time / tx', value: sessionTimePerTx, kind: 'duration_ms' },
			{ metric: 'Idle in transaction time / tx', value: idleInTransactionTimePerTx, kind: 'duration_ms' },
			{ metric: 'Parallel workers to launch', value: parallelWorkersToLaunch, kind: 'count' },
			{ metric: 'Parallel workers launched', value: parallelWorkersLaunched, kind: 'count' },
			{ metric: 'Parallel launch success', value: parallelLaunchSuccess, kind: 'percent' },
			{ metric: 'Parallel workers / tx', value: parallelWorkersPerTx, kind: 'count' },
			{ metric: 'Deadlocks', value: deadlocks, kind: 'count' },
			{ metric: 'Deadlocks / 1M tx', value: deadlocksPerMillionTx, kind: 'count' },
			{ metric: 'Block read time (ms)', value: blockReadTime, kind: 'duration_ms' },
			{ metric: 'Block write time (ms)', value: blockWriteTime, kind: 'duration_ms' }
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) => {
			const commit = deltaAt(snapshotRows, index, 'xact_commit');
			const rollback = deltaAt(snapshotRows, index, 'xact_rollback');
			const transactions = sum([commit, rollback]);
			const snapshotBlocksRead = deltaAt(snapshotRows, index, 'blks_read');
			const snapshotBlocksHit = deltaAt(snapshotRows, index, 'blks_hit');
			const snapshotBlockAccess = sum([snapshotBlocksRead, snapshotBlocksHit]);
			const snapshotRowsReturned = deltaAt(snapshotRows, index, 'tup_returned');
			const snapshotRowsFetched = deltaAt(snapshotRows, index, 'tup_fetched');
			const snapshotRowsWritten = sum([
				deltaAt(snapshotRows, index, 'tup_inserted'),
				deltaAt(snapshotRows, index, 'tup_updated'),
				deltaAt(snapshotRows, index, 'tup_deleted')
			]);
			const snapshotTempBytes = deltaAt(snapshotRows, index, 'temp_bytes');
			const snapshotTempFiles = deltaAt(snapshotRows, index, 'temp_files');
			const snapshotSessions = deltaAt(snapshotRows, index, 'sessions');
			const snapshotSessionsAbandoned = deltaAt(snapshotRows, index, 'sessions_abandoned');
			const snapshotSessionsFatal = deltaAt(snapshotRows, index, 'sessions_fatal');
			const snapshotSessionsKilled = deltaAt(snapshotRows, index, 'sessions_killed');
			const snapshotActiveTime = deltaAt(snapshotRows, index, 'active_time');
			const snapshotSessionTime = deltaAt(snapshotRows, index, 'session_time');
			const snapshotIdleInTransactionTime = deltaAt(snapshotRows, index, 'idle_in_transaction_time');
			const snapshotParallelWorkersToLaunch = deltaAt(snapshotRows, index, 'parallel_workers_to_launch');
			const snapshotParallelWorkersLaunched = deltaAt(snapshotRows, index, 'parallel_workers_launched');
			const snapshotBlockReadTime = deltaAt(snapshotRows, index, 'blk_read_time');
			const snapshotBlockWriteTime = deltaAt(snapshotRows, index, 'blk_write_time');
			const snapshotDeadlocks = deltaAt(snapshotRows, index, 'deadlocks');
			const snapshotDeadlocksPerMillion = (() => {
				const value = safeRatio(snapshotDeadlocks, transactions);
				return value === null ? null : value * 1_000_000;
			})();
			return makeMetricRows([
				{ metric: 'Transactions', value: transactions, kind: 'count' },
				{ metric: 'Commits', value: commit, kind: 'count' },
				{ metric: 'Rollbacks', value: rollback, kind: 'count' },
				{ metric: 'DB-stat TPS', value: safeRatio(transactions, elapsedSecondsAt(snapshotRows, index)), kind: 'tps' },
				{ metric: 'Buffer hit ratio', value: ratioAt(snapshotRows, index, 'blks_hit', ['blks_hit', 'blks_read']), kind: 'percent' },
				{ metric: 'Cache miss rate', value: ratioAt(snapshotRows, index, 'blks_read', ['blks_hit', 'blks_read']), kind: 'percent' },
				{ metric: 'Blocks read', value: snapshotBlocksRead, kind: 'count' },
				{ metric: 'Blocks hit', value: snapshotBlocksHit, kind: 'count' },
				{ metric: 'Disk reads / tx', value: safeRatio(snapshotBlocksRead, transactions), kind: 'count' },
				{ metric: 'Block access / tx', value: safeRatio(snapshotBlockAccess, transactions), kind: 'count' },
				{ metric: 'Rows inserted', value: deltaAt(snapshotRows, index, 'tup_inserted'), kind: 'count' },
				{ metric: 'Rows updated', value: deltaAt(snapshotRows, index, 'tup_updated'), kind: 'count' },
				{ metric: 'Rows deleted', value: deltaAt(snapshotRows, index, 'tup_deleted'), kind: 'count' },
				{ metric: 'Rows returned / tx', value: safeRatio(snapshotRowsReturned, transactions), kind: 'count' },
				{ metric: 'Rows fetched / tx', value: safeRatio(snapshotRowsFetched, transactions), kind: 'count' },
				{ metric: 'Rows written / tx', value: safeRatio(snapshotRowsWritten, transactions), kind: 'count' },
				{ metric: 'Returned / fetched', value: safeRatio(snapshotRowsReturned, snapshotRowsFetched), kind: 'count' },
				{ metric: 'Write mix', value: safeRatio(snapshotRowsWritten, sum([snapshotRowsReturned, snapshotRowsFetched, snapshotRowsWritten])), kind: 'percent' },
				{ metric: 'Temp bytes', value: snapshotTempBytes, kind: 'bytes' },
				{ metric: 'Temp files', value: snapshotTempFiles, kind: 'count' },
				{ metric: 'Temp bytes / tx', value: safeRatio(snapshotTempBytes, transactions), kind: 'bytes' },
				{ metric: 'Temp files / tx', value: safeRatio(snapshotTempFiles, transactions), kind: 'count' },
				{ metric: 'Avg temp file size', value: safeRatio(snapshotTempBytes, snapshotTempFiles), kind: 'bytes' },
				{ metric: 'Sessions', value: snapshotSessions, kind: 'count' },
				{ metric: 'Sessions abandoned', value: snapshotSessionsAbandoned, kind: 'count' },
				{ metric: 'Sessions fatal', value: snapshotSessionsFatal, kind: 'count' },
				{ metric: 'Sessions killed', value: snapshotSessionsKilled, kind: 'count' },
				{ metric: 'Session time (ms)', value: snapshotSessionTime, kind: 'duration_ms' },
				{ metric: 'Active time (ms)', value: snapshotActiveTime, kind: 'duration_ms' },
				{ metric: 'Idle in transaction time (ms)', value: snapshotIdleInTransactionTime, kind: 'duration_ms' },
				{ metric: 'I/O time / active time', value: safeRatio(sum([snapshotBlockReadTime, snapshotBlockWriteTime]), snapshotActiveTime), kind: 'percent' },
				{ metric: 'Active time / tx', value: safeRatio(snapshotActiveTime, transactions), kind: 'duration_ms' },
				{ metric: 'Session time / tx', value: safeRatio(snapshotSessionTime, transactions), kind: 'duration_ms' },
				{ metric: 'Idle in transaction time / tx', value: safeRatio(snapshotIdleInTransactionTime, transactions), kind: 'duration_ms' },
				{ metric: 'Parallel workers to launch', value: snapshotParallelWorkersToLaunch, kind: 'count' },
				{ metric: 'Parallel workers launched', value: snapshotParallelWorkersLaunched, kind: 'count' },
				{ metric: 'Parallel launch success', value: safeRatio(snapshotParallelWorkersLaunched, snapshotParallelWorkersToLaunch), kind: 'percent' },
				{ metric: 'Parallel workers / tx', value: safeRatio(snapshotParallelWorkersLaunched, transactions), kind: 'count' },
				{ metric: 'Deadlocks', value: snapshotDeadlocks, kind: 'count' },
				{ metric: 'Deadlocks / 1M tx', value: snapshotDeadlocksPerMillion, kind: 'count' },
				{ metric: 'Block read time (ms)', value: snapshotBlockReadTime, kind: 'duration_ms' },
				{ metric: 'Block write time (ms)', value: snapshotBlockWriteTime, kind: 'duration_ms' }
			]);
		})
	};
}

function buildWalSection(rows: SnapshotRow[], runStartMs: number, transactionRows: SnapshotRow[]): TelemetrySection {
	const walBytes = delta(rows, 'wal_bytes');
	const walRecords = delta(rows, 'wal_records');
	const walFpi = delta(rows, 'wal_fpi');
	const walBuffersFull = delta(rows, 'wal_buffers_full');
	const transactions = sum([delta(transactionRows, 'xact_commit'), delta(transactionRows, 'xact_rollback')]);
	const walRate = safeRatio(walBytes, elapsedSeconds(rows));
	const walBytesPerTx = safeRatio(walBytes, transactions);
	const walRecordsPerTx = safeRatio(walRecords, transactions);
	const walBuffersFullPerMb = (() => {
		const value = safeRatio(walBuffersFull, walBytes);
		return value === null ? null : value * 1024 * 1024;
	})();

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

	const walChartMetrics: TelemetryChartMetric[] = [];
	const WAL_GROUP = {
		volume: 'WAL Volume',
		records: 'Record Shape',
		buffers: 'Buffer Pressure',
		efficiency: 'Efficiency'
	} as const;
	const PG_STAT_WAL_DOCS = {
		wal_records: 'Total number of WAL records generated.',
		wal_fpi: 'Total number of WAL full page images generated.',
		wal_bytes: 'Total amount of WAL generated in bytes.',
		wal_buffers_full: 'Number of times WAL data was written to disk because WAL buffers became full.'
	} as const;
	const walSource = (columns: string[]) => `Source: pg_stat_wal.${columns.join(', pg_stat_wal.')}.`;
	const walRateDescription = (description: string, columns: string[]) => `${description} Shown as a per second delta. ${walSource(columns)}`;
	const walRawDescription = (description: string, columns: string[]) => `${description} Raw view shows the cumulative delta since the first selected sample. ${walSource(columns)}`;
	const walDerivedDescription = (description: string, uses: string) => `${description} Uses: ${uses}.`;
	const pushWal = (m: TelemetryChartMetric | null, group: string) => {
		if (m && (m.series.length > 0 || (m.rawSeries?.length ?? 0) > 0)) walChartMetrics.push({ ...m, group });
	};
	const walRowsWritten = sum([
		delta(transactionRows, 'tup_inserted'),
		delta(transactionRows, 'tup_updated'),
		delta(transactionRows, 'tup_deleted')
	]);
	const walBytesPerRowWritten = safeRatio(walBytes, walRowsWritten);
	const walBuffersFullPerKTx = (() => {
		const value = safeRatio(walBuffersFull, transactions);
		return value === null ? null : value * 1000;
	})();
	const transactionsAt = (walSnapshotRows: SnapshotRow[], walIndex: number): number | null => {
		if (transactionRows.length === 0) return null;
		const walTs = toMs(String(walSnapshotRows[walIndex]?._collected_at ?? ''));
		let txIndex = -1;
		for (let index = 0; index < transactionRows.length; index++) {
			const txTs = toMs(String(transactionRows[index]._collected_at));
			if (walTs !== null && txTs !== null && txTs <= walTs) txIndex = index;
		}
		if (txIndex < 0) txIndex = Math.min(walIndex, transactionRows.length - 1);
		return sumDeltaAt(transactionRows, txIndex, ['xact_commit', 'xact_rollback']);
	};
	const rowsWrittenAt = (walSnapshotRows: SnapshotRow[], walIndex: number): number | null => {
		if (transactionRows.length === 0) return null;
		const walTs = toMs(String(walSnapshotRows[walIndex]?._collected_at ?? ''));
		let txIndex = -1;
		for (let index = 0; index < transactionRows.length; index++) {
			const txTs = toMs(String(transactionRows[index]._collected_at));
			if (walTs !== null && txTs !== null && txTs <= walTs) txIndex = index;
		}
		if (txIndex < 0) txIndex = Math.min(walIndex, transactionRows.length - 1);
		return sumDeltaAt(transactionRows, txIndex, ['tup_inserted', 'tup_updated', 'tup_deleted']);
	};

	const walBytesRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'wal bytes/s', description: walRateDescription(PG_STAT_WAL_DOCS.wal_bytes, ['wal_bytes']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_bytes'), elapsedSecondsAt(r, i)) }
	]);
	const walBytesRaw = buildMetricSeries(rows, runStartMs, [{ label: 'wal bytes', description: walRawDescription(PG_STAT_WAL_DOCS.wal_bytes, ['wal_bytes']), valueFn: (row) => toNumber(row.wal_bytes) }]);
	pushWal({ key: 'wal_bytes', label: 'WAL Bytes', description: walRateDescription(PG_STAT_WAL_DOCS.wal_bytes, ['wal_bytes']), kind: 'bytes', title: 'WAL volume over time', category: 'raw', series: walBytesRate, rawSeries: walBytesRaw }, WAL_GROUP.volume);

	const walCountsRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'records/s', description: walRateDescription(PG_STAT_WAL_DOCS.wal_records, ['wal_records']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_records'), elapsedSecondsAt(r, i)) },
		{ label: 'full page images/s', description: walRateDescription(PG_STAT_WAL_DOCS.wal_fpi, ['wal_fpi']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_fpi'), elapsedSecondsAt(r, i)) }
	]);
	const walCountsRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'wal records', description: walRawDescription(PG_STAT_WAL_DOCS.wal_records, ['wal_records']), valueFn: (row) => toNumber(row.wal_records) },
		{ label: 'full page images', description: walRawDescription(PG_STAT_WAL_DOCS.wal_fpi, ['wal_fpi']), valueFn: (row) => toNumber(row.wal_fpi) }
	]);
	pushWal({ key: 'wal_counts', label: 'WAL Records', description: 'WAL record and full-page-image counters from pg_stat_wal, shown as per second deltas.', kind: 'count', title: 'WAL record counts over time', category: 'raw', series: walCountsRate, rawSeries: walCountsRaw }, WAL_GROUP.records);

	const walBufferFullRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers full/s', description: walRateDescription(PG_STAT_WAL_DOCS.wal_buffers_full, ['wal_buffers_full']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_buffers_full'), elapsedSecondsAt(r, i)) }
	]);
	const walBufferFullRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'wal buffers full', description: walRawDescription(PG_STAT_WAL_DOCS.wal_buffers_full, ['wal_buffers_full']), valueFn: (row) => toNumber(row.wal_buffers_full) }
	]);
	pushWal({ key: 'wal_buffers_full', label: 'WAL Buffers Full', description: walRateDescription(PG_STAT_WAL_DOCS.wal_buffers_full, ['wal_buffers_full']), kind: 'count', title: 'WAL buffer-full events over time', category: 'raw', series: walBufferFullRate, rawSeries: walBufferFullRaw }, WAL_GROUP.buffers);

	const fpiRatioSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'FPI ratio', description: walDerivedDescription('Share of WAL records that were full-page images; higher values often point to checkpoint-driven page rewrites.', 'wal_fpi / wal_records'), seriesValueAt: (r, i) => ratioAt(r, i, 'wal_fpi', ['wal_records']) }
	]);
	pushWal({ key: 'fpi_ratio', label: 'FPI Ratio', description: walDerivedDescription('Share of WAL records that were full-page images; higher values often point to checkpoint-driven page rewrites.', 'wal_fpi / wal_records'), kind: 'percent', title: 'Full-page image ratio over time', category: 'derived', series: fpiRatioSeries }, WAL_GROUP.records);

	const walBytesPerRecordSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'bytes / record', description: walDerivedDescription('Average WAL bytes per record; rising values indicate larger WAL records or more full-page-image payload.', 'wal_bytes / wal_records'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_bytes'), deltaAt(r, i, 'wal_records')) }
	]);
	pushWal({ key: 'wal_bytes_per_record', label: 'WAL / Record', description: walDerivedDescription('Average WAL bytes per record; rising values indicate larger WAL records or more full-page-image payload.', 'wal_bytes / wal_records'), kind: 'bytes', title: 'Avg WAL bytes per record', category: 'derived', series: walBytesPerRecordSeries }, WAL_GROUP.efficiency);

	const walBytesPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'bytes / tx', description: walDerivedDescription('WAL volume normalized by database transaction count; useful for comparing write amplification across runs.', 'wal_bytes / transactions'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_bytes'), transactionsAt(r, i)) }
	]);
	pushWal({ key: 'wal_bytes_per_tx', label: 'WAL / Tx', description: walDerivedDescription('WAL volume normalized by database transaction count; useful for comparing write amplification across runs.', 'wal_bytes / transactions'), kind: 'bytes', title: 'WAL bytes per transaction', category: 'derived', series: walBytesPerTxSeries }, WAL_GROUP.efficiency);

	const walRecordsPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'records / tx', description: walDerivedDescription('WAL record count normalized by transaction count; helps separate many small records from large WAL payloads.', 'wal_records / transactions'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_records'), transactionsAt(r, i)) }
	]);
	pushWal({ key: 'wal_records_per_tx', label: 'Records / Tx', description: walDerivedDescription('WAL record count normalized by transaction count; helps separate many small records from large WAL payloads.', 'wal_records / transactions'), kind: 'count', title: 'WAL records per transaction', category: 'derived', series: walRecordsPerTxSeries }, WAL_GROUP.efficiency);

	const walBuffersFullPerMbSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers full / MiB', description: walDerivedDescription('WAL buffer-full events normalized by WAL volume; high values suggest WAL buffer pressure relative to generated WAL.', 'wal_buffers_full / wal_bytes'), seriesValueAt: (r, i) => {
			const value = safeRatio(deltaAt(r, i, 'wal_buffers_full'), deltaAt(r, i, 'wal_bytes'));
			return value === null ? null : value * 1024 * 1024;
		} }
	]);
	pushWal({ key: 'wal_buffers_full_per_mb', label: 'Buffers Full / MiB', description: walDerivedDescription('WAL buffer-full events normalized by WAL volume; high values suggest WAL buffer pressure relative to generated WAL.', 'wal_buffers_full / wal_bytes'), kind: 'count', title: 'WAL buffer-full events per MiB generated', category: 'derived', series: walBuffersFullPerMbSeries }, WAL_GROUP.buffers);

	const walBytesPerRowWrittenSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'bytes / row written', description: walDerivedDescription('WAL bytes per row change (insert + update + delete); captures write amplification at the row level independently of transaction batch size — a useful design comparison metric.', 'wal_bytes / (tup_inserted + tup_updated + tup_deleted)'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'wal_bytes'), rowsWrittenAt(r, i)) }
	]);
	pushWal({ key: 'wal_bytes_per_row_written', label: 'WAL / Row Written', description: walDerivedDescription('WAL bytes per row change (insert + update + delete); captures write amplification at the row level independently of transaction batch size — a useful design comparison metric.', 'wal_bytes / (tup_inserted + tup_updated + tup_deleted)'), kind: 'bytes', title: 'WAL bytes per row written', category: 'derived', series: walBytesPerRowWrittenSeries }, WAL_GROUP.efficiency);

	const walBuffersFullPerKTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers full / 1k tx', description: walDerivedDescription('WAL buffer-full events per 1000 transactions; removes run-duration bias for cross-run comparison — a design with a higher value sustains more WAL buffer pressure per unit of work.', '(wal_buffers_full / transactions) × 1000'), seriesValueAt: (r, i) => {
			const value = safeRatio(deltaAt(r, i, 'wal_buffers_full'), transactionsAt(r, i));
			return value === null ? null : value * 1000;
		} }
	]);
	pushWal({ key: 'wal_buffers_full_per_k_tx', label: 'Buffers Full / 1k Tx', description: walDerivedDescription('WAL buffer-full events per 1000 transactions; removes run-duration bias for cross-run comparison — a design with a higher value sustains more WAL buffer pressure per unit of work.', '(wal_buffers_full / transactions) × 1000'), kind: 'count', title: 'WAL buffer-full events per 1000 transactions', category: 'derived', series: walBuffersFullPerKTxSeries }, WAL_GROUP.buffers);

	return {
		key: 'wal',
		label: 'WAL',
		status: 'ok',
		summary: [],
		chartTitle: walChartMetrics[0]?.title ?? 'WAL metrics over time',
		chartSeries: walChartMetrics[0]?.series ?? [],
		chartMetrics: walChartMetrics,
		defaultChartMetricKey: 'wal_bytes',
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
			{ metric: 'WAL bytes / tx', value: walBytesPerTx, kind: 'bytes' },
			{ metric: 'WAL records / tx', value: walRecordsPerTx, kind: 'count' },
			{ metric: 'WAL bytes / row written', value: walBytesPerRowWritten, kind: 'bytes' },
			{ metric: 'WAL rate', value: walRate, kind: 'bytes' },
			{ metric: 'WAL buffers full', value: walBuffersFull, kind: 'count' },
			{ metric: 'WAL buffers full / MiB', value: walBuffersFullPerMb, kind: 'count' },
			{ metric: 'WAL buffers full / 1k tx', value: walBuffersFullPerKTx, kind: 'count' }
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
				{ metric: 'WAL bytes / tx', value: safeRatio(deltaAt(snapshotRows, index, 'wal_bytes'), transactionsAt(snapshotRows, index)), kind: 'bytes' },
				{ metric: 'WAL records / tx', value: safeRatio(deltaAt(snapshotRows, index, 'wal_records'), transactionsAt(snapshotRows, index)), kind: 'count' },
				{ metric: 'WAL bytes / row written', value: safeRatio(deltaAt(snapshotRows, index, 'wal_bytes'), rowsWrittenAt(snapshotRows, index)), kind: 'bytes' },
				{ metric: 'WAL rate', value: safeRatio(deltaAt(snapshotRows, index, 'wal_bytes'), elapsedSecondsAt(snapshotRows, index)), kind: 'bytes' },
				{ metric: 'WAL buffers full', value: deltaAt(snapshotRows, index, 'wal_buffers_full'), kind: 'count' },
				{
					metric: 'WAL buffers full / MiB',
					value: (() => {
						const value = safeRatio(deltaAt(snapshotRows, index, 'wal_buffers_full'), deltaAt(snapshotRows, index, 'wal_bytes'));
						return value === null ? null : value * 1024 * 1024;
					})(),
					kind: 'count'
				},
				{
					metric: 'WAL buffers full / 1k tx',
					value: (() => {
						const value = safeRatio(deltaAt(snapshotRows, index, 'wal_buffers_full'), transactionsAt(snapshotRows, index));
						return value === null ? null : value * 1000;
					})(),
					kind: 'count'
				}
			])
		)
	};
}

function buildBgwriterSection(rows: SnapshotRow[], runStartMs: number, databaseRows: SnapshotRow[]): TelemetrySection {
	const buffersClean = delta(rows, 'buffers_clean');
	const maxwrittenClean = delta(rows, 'maxwritten_clean');
	const buffersAlloc = delta(rows, 'buffers_alloc');
	const throttleRatio = safeRatio(maxwrittenClean, buffersClean);
	const allocCoverage = safeRatio(buffersClean, buffersAlloc);
	const transactions = sum([delta(databaseRows, 'xact_commit'), delta(databaseRows, 'xact_rollback')]);
	const blksHit = delta(databaseRows, 'blks_hit');
	const blksRead = delta(databaseRows, 'blks_read');
	const totalCacheAccess = sum([blksHit, blksRead]);
	const buffersAllocPerTx = safeRatio(buffersAlloc, transactions);
	const buffersCleanPerTx = safeRatio(buffersClean, transactions);
	const allocPerCacheAccess = safeRatio(buffersAlloc, totalCacheAccess);
	const throttlePerKTx = (() => {
		const value = safeRatio(maxwrittenClean, transactions);
		return value === null ? null : value * 1000;
	})();

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

	const bgwChartMetrics: TelemetryChartMetric[] = [];
	const BGW_GROUP = {
		output: 'Buffer Output',
		throttle: 'Throttle',
		efficiency: 'Efficiency',
		workload: 'Workload Shape'
	} as const;
	const transactionsAt = (bgwRows: SnapshotRow[], bgwIndex: number): number | null => {
		if (databaseRows.length === 0) return null;
		const bgwTs = toMs(String(bgwRows[bgwIndex]?._collected_at ?? ''));
		let txIndex = -1;
		for (let index = 0; index < databaseRows.length; index++) {
			const txTs = toMs(String(databaseRows[index]._collected_at));
			if (bgwTs !== null && txTs !== null && txTs <= bgwTs) txIndex = index;
		}
		if (txIndex < 0) txIndex = Math.min(bgwIndex, databaseRows.length - 1);
		return sumDeltaAt(databaseRows, txIndex, ['xact_commit', 'xact_rollback']);
	};
	const cacheAccessAt = (bgwRows: SnapshotRow[], bgwIndex: number): number | null => {
		if (databaseRows.length === 0) return null;
		const bgwTs = toMs(String(bgwRows[bgwIndex]?._collected_at ?? ''));
		let dbIndex = -1;
		for (let index = 0; index < databaseRows.length; index++) {
			const dbTs = toMs(String(databaseRows[index]._collected_at));
			if (bgwTs !== null && dbTs !== null && dbTs <= bgwTs) dbIndex = index;
		}
		if (dbIndex < 0) dbIndex = Math.min(bgwIndex, databaseRows.length - 1);
		return sumDeltaAt(databaseRows, dbIndex, ['blks_hit', 'blks_read']);
	};
	const PG_STAT_BGWRITER_DOCS = {
		buffers_clean: 'Number of buffers written by the background writer.',
		maxwritten_clean: 'Number of times the background writer stopped a cleaning scan because it had written too many buffers.',
		buffers_alloc: 'Number of buffers allocated.'
	} as const;
	const bgwSource = (columns: string[]) => `Source: pg_stat_bgwriter.${columns.join(', pg_stat_bgwriter.')}.`;
	const bgwRateDescription = (description: string, columns: string[]) => `${description} Shown as a per second delta. ${bgwSource(columns)}`;
	const bgwRawDescription = (description: string, columns: string[]) => `${description} Raw view shows the cumulative delta since the first selected sample. ${bgwSource(columns)}`;
	const bgwDerivedDescription = (description: string, uses: string) => `${description} Uses: ${uses}.`;
	const pushBgw = (m: TelemetryChartMetric | null, group: string) => {
		if (m && (m.series.length > 0 || (m.rawSeries?.length ?? 0) > 0)) bgwChartMetrics.push({ ...m, group });
	};

	const buffersCleanRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers clean/s', description: bgwRateDescription(PG_STAT_BGWRITER_DOCS.buffers_clean, ['buffers_clean']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_clean'), elapsedSecondsAt(r, i)) }
	]);
	const buffersCleanRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'buffers clean', description: bgwRawDescription(PG_STAT_BGWRITER_DOCS.buffers_clean, ['buffers_clean']), valueFn: (row) => toNumber(row.buffers_clean) }
	]);
	pushBgw({ key: 'buffers_clean', label: 'Buffers Clean', description: bgwRateDescription(PG_STAT_BGWRITER_DOCS.buffers_clean, ['buffers_clean']), kind: 'count', title: 'BGWriter buffer writes over time', category: 'raw', series: buffersCleanRate, rawSeries: buffersCleanRaw }, BGW_GROUP.output);

	const buffersAllocRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers alloc/s', description: bgwRateDescription(PG_STAT_BGWRITER_DOCS.buffers_alloc, ['buffers_alloc']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_alloc'), elapsedSecondsAt(r, i)) }
	]);
	const buffersAllocRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'buffers alloc', description: bgwRawDescription(PG_STAT_BGWRITER_DOCS.buffers_alloc, ['buffers_alloc']), valueFn: (row) => toNumber(row.buffers_alloc) }
	]);
	pushBgw({ key: 'buffers_alloc', label: 'Buffers Alloc', description: bgwRateDescription(PG_STAT_BGWRITER_DOCS.buffers_alloc, ['buffers_alloc']), kind: 'count', title: 'Buffer allocations over time', category: 'raw', series: buffersAllocRate, rawSeries: buffersAllocRaw }, BGW_GROUP.output);

	const maxwrittenCleanRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'maxwritten clean/s', description: bgwRateDescription(PG_STAT_BGWRITER_DOCS.maxwritten_clean, ['maxwritten_clean']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'maxwritten_clean'), elapsedSecondsAt(r, i)) }
	]);
	const maxwrittenCleanRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'maxwritten clean', description: bgwRawDescription(PG_STAT_BGWRITER_DOCS.maxwritten_clean, ['maxwritten_clean']), valueFn: (row) => toNumber(row.maxwritten_clean) }
	]);
	pushBgw({ key: 'maxwritten_clean', label: 'Maxwritten Clean', description: bgwRateDescription(PG_STAT_BGWRITER_DOCS.maxwritten_clean, ['maxwritten_clean']), kind: 'count', title: 'BGWriter throttle events over time', category: 'raw', series: maxwrittenCleanRate, rawSeries: maxwrittenCleanRaw }, BGW_GROUP.throttle);

	const throttleRatioSeries = buildDerivedSeries(rows, runStartMs, [
		{
			label: 'throttle ratio',
			description: bgwDerivedDescription('Share of BGWriter cleaning scans cut short by bgwriter_lru_maxpages; high values indicate BGWriter is frequently throttled and backends may be evicting pages themselves.', 'maxwritten_clean / buffers_clean'),
			seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'maxwritten_clean'), deltaAt(r, i, 'buffers_clean'))
		}
	]);
	pushBgw({ key: 'throttle_ratio', label: 'Throttle Ratio', description: bgwDerivedDescription('Share of BGWriter cleaning scans cut short by bgwriter_lru_maxpages; high values indicate BGWriter is frequently throttled and backends may be evicting pages themselves.', 'maxwritten_clean / buffers_clean'), kind: 'percent', title: 'BGWriter throttle ratio over time', category: 'derived', series: throttleRatioSeries }, BGW_GROUP.throttle);

	const allocCoverageSeries = buildDerivedSeries(rows, runStartMs, [
		{
			label: 'alloc coverage',
			description: bgwDerivedDescription('Fraction of buffer allocations pre-cleaned by the BGWriter; low values suggest backends are bearing most of the eviction cost (victim eviction), adding latency to queries.', 'buffers_clean / buffers_alloc'),
			seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_clean'), deltaAt(r, i, 'buffers_alloc'))
		}
	]);
	pushBgw({ key: 'alloc_coverage', label: 'Alloc Coverage', description: bgwDerivedDescription('Fraction of buffer allocations pre-cleaned by the BGWriter; low values suggest backends are bearing most of the eviction cost (victim eviction), adding latency to queries.', 'buffers_clean / buffers_alloc'), kind: 'percent', title: 'BGWriter alloc coverage over time', category: 'derived', series: allocCoverageSeries }, BGW_GROUP.efficiency);

	const buffersAllocPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{
			label: 'buffers alloc / tx',
			description: bgwDerivedDescription('New shared buffer page allocations per transaction; lower values indicate a more cache-resident working set that will scale better under higher concurrency.', 'buffers_alloc / transactions'),
			seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_alloc'), transactionsAt(r, i))
		}
	]);
	pushBgw({ key: 'buffers_alloc_per_tx', label: 'Alloc / Tx', description: bgwDerivedDescription('New shared buffer page allocations per transaction; lower values indicate a more cache-resident working set that will scale better under higher concurrency.', 'buffers_alloc / transactions'), kind: 'count', title: 'Buffer allocations per transaction over time', category: 'derived', series: buffersAllocPerTxSeries }, BGW_GROUP.workload);

	const buffersCleanPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{
			label: 'buffers clean / tx',
			description: bgwDerivedDescription('BGWriter proactive buffer writes per transaction; a design with higher values is dirtying more pages per unit of work, which also predicts more checkpoint write pressure.', 'buffers_clean / transactions'),
			seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_clean'), transactionsAt(r, i))
		}
	]);
	pushBgw({ key: 'buffers_clean_per_tx', label: 'Clean / Tx', description: bgwDerivedDescription('BGWriter proactive buffer writes per transaction; a design with higher values is dirtying more pages per unit of work, which also predicts more checkpoint write pressure.', 'buffers_clean / transactions'), kind: 'count', title: 'BGWriter buffer writes per transaction over time', category: 'derived', series: buffersCleanPerTxSeries }, BGW_GROUP.workload);

	const allocPerCacheAccessSeries = buildDerivedSeries(rows, runStartMs, [
		{
			label: 'alloc / cache access',
			description: bgwDerivedDescription('Fraction of buffer accesses that required a new page allocation (i.e. a cold-page miss); high values indicate the working set frequently exceeds shared_buffers and increasing it may help.', 'buffers_alloc / (blks_hit + blks_read)'),
			seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_alloc'), cacheAccessAt(r, i))
		}
	]);
	pushBgw({ key: 'alloc_per_cache_access', label: 'Alloc / Cache Access', description: bgwDerivedDescription('Fraction of buffer accesses that required a new page allocation (i.e. a cold-page miss); high values indicate the working set frequently exceeds shared_buffers and increasing it may help.', 'buffers_alloc / (blks_hit + blks_read)'), kind: 'percent', title: 'Buffer allocations per cache access over time', category: 'derived', series: allocPerCacheAccessSeries }, BGW_GROUP.workload);

	const throttlePerKTxSeries = buildDerivedSeries(rows, runStartMs, [
		{
			label: 'throttle events / 1k tx',
			description: bgwDerivedDescription('BGWriter throttle events per 1000 transactions; removes run-duration bias for cross-run comparison — a design with higher values puts more cleaning pressure on the BGWriter per unit of work.', '(maxwritten_clean / transactions) × 1000'),
			seriesValueAt: (r, i) => {
				const value = safeRatio(deltaAt(r, i, 'maxwritten_clean'), transactionsAt(r, i));
				return value === null ? null : value * 1000;
			}
		}
	]);
	pushBgw({ key: 'throttle_per_k_tx', label: 'Throttle / 1k Tx', description: bgwDerivedDescription('BGWriter throttle events per 1000 transactions; removes run-duration bias for cross-run comparison — a design with higher values puts more cleaning pressure on the BGWriter per unit of work.', '(maxwritten_clean / transactions) × 1000'), kind: 'count', title: 'BGWriter throttle events per 1000 transactions over time', category: 'derived', series: throttlePerKTxSeries }, BGW_GROUP.workload);

	return {
		key: 'bgwriter',
		label: 'BGWriter',
		status: 'ok',
		summary: [],
		chartTitle: bgwChartMetrics[0]?.title ?? 'Background writer activity over time',
		chartSeries: bgwChartMetrics[0]?.series ?? [],
		chartMetrics: bgwChartMetrics,
		defaultChartMetricKey: 'buffers_clean',
		tableTitle: 'BGWriter metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value' }
		],
		tableRows: makeMetricRows([
			{ metric: 'Buffers clean', value: buffersClean, kind: 'count' },
			{ metric: 'Buffers alloc', value: buffersAlloc, kind: 'count' },
			{ metric: 'Maxwritten clean', value: maxwrittenClean, kind: 'count' },
			{ metric: 'Throttle ratio', value: throttleRatio, kind: 'percent' },
			{ metric: 'Alloc coverage', value: allocCoverage, kind: 'percent' },
			{ metric: 'Buffers alloc / tx', value: buffersAllocPerTx, kind: 'count' },
			{ metric: 'Buffers clean / tx', value: buffersCleanPerTx, kind: 'count' },
			{ metric: 'Alloc / cache access', value: allocPerCacheAccess, kind: 'percent' },
			{ metric: 'Throttle / 1k tx', value: throttlePerKTx, kind: 'count' },
			{ metric: 'Stats reset', value: latestText(rows, 'stats_reset'), kind: 'text' }
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) =>
			makeMetricRows([
				{ metric: 'Buffers clean', value: deltaAt(snapshotRows, index, 'buffers_clean'), kind: 'count' },
				{ metric: 'Buffers alloc', value: deltaAt(snapshotRows, index, 'buffers_alloc'), kind: 'count' },
				{ metric: 'Maxwritten clean', value: deltaAt(snapshotRows, index, 'maxwritten_clean'), kind: 'count' },
				{ metric: 'Throttle ratio', value: safeRatio(deltaAt(snapshotRows, index, 'maxwritten_clean'), deltaAt(snapshotRows, index, 'buffers_clean')), kind: 'percent' },
				{ metric: 'Alloc coverage', value: safeRatio(deltaAt(snapshotRows, index, 'buffers_clean'), deltaAt(snapshotRows, index, 'buffers_alloc')), kind: 'percent' },
				{ metric: 'Buffers alloc / tx', value: safeRatio(deltaAt(snapshotRows, index, 'buffers_alloc'), transactionsAt(snapshotRows, index)), kind: 'count' },
				{ metric: 'Buffers clean / tx', value: safeRatio(deltaAt(snapshotRows, index, 'buffers_clean'), transactionsAt(snapshotRows, index)), kind: 'count' },
				{ metric: 'Alloc / cache access', value: safeRatio(deltaAt(snapshotRows, index, 'buffers_alloc'), cacheAccessAt(snapshotRows, index)), kind: 'percent' },
				{ metric: 'Throttle / 1k tx', value: (() => { const v = safeRatio(deltaAt(snapshotRows, index, 'maxwritten_clean'), transactionsAt(snapshotRows, index)); return v === null ? null : v * 1000; })(), kind: 'count' },
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

	const archivedCount = delta(rows, 'archived_count');
	const failedCount = delta(rows, 'failed_count');

	return {
		key: 'archiver',
		label: 'Archiver',
		status: 'ok',
		summary: [],
		chartTitle: 'Archived WAL segments over time',
		chartSeries: buildDerivedSeries(rows, runStartMs, [
			{ label: 'archived/s', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'archived_count'), elapsedSecondsAt(r, i)) }
		]),
		chartMetrics: ([
			{
				key: 'archive_counts',
				label: 'Archive Counts',
				description: 'Number of WAL segments archived and failed. Raw view shows cumulative delta. Source: pg_stat_archiver.archived_count, pg_stat_archiver.failed_count.',
				kind: 'count' as TelemetryValueKind,
				title: 'WAL segments archived and failed over time',
				category: 'raw' as const,
				series: buildDerivedSeries(rows, runStartMs, [
					{ label: 'archived/s', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'archived_count'), elapsedSecondsAt(r, i)) },
					{ label: 'failed/s', seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'failed_count'), elapsedSecondsAt(r, i)) }
				]),
				rawSeries: buildMetricSeries(rows, runStartMs, [
					{ label: 'archived', valueFn: (row) => toNumber(row.archived_count) },
					{ label: 'failed', valueFn: (row) => toNumber(row.failed_count) }
				])
			},
			{
				key: 'failure_rate',
				label: 'Failure Rate',
				description: 'Share of archive attempts that failed; any non-zero value warrants investigation as archive failures can cause WAL accumulation and eventually halt the database. Uses: failed_count / (archived_count + failed_count).',
				kind: 'percent' as TelemetryValueKind,
				title: 'Archive failure rate over time',
				category: 'derived' as const,
				series: buildDerivedSeries(rows, runStartMs, [
					{ label: 'failure rate', seriesValueAt: (r, i) => ratioAt(r, i, 'failed_count', ['archived_count', 'failed_count']) }
				])
			}
		] as TelemetryChartMetric[]).filter((m) => m.series.length > 0),
		defaultChartMetricKey: 'archive_counts',
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

function buildIoSection(rows: SnapshotRow[], runStartMs: number, databaseRows: SnapshotRow[]): TelemetrySection {
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

	const IO_GROUP = {
		volume: 'Data Volume',
		operations: 'Operations',
		latency: 'Latency',
		buffer: 'Buffer Pressure',
		sync: 'Writeback & Sync',
		growth: 'Relation Growth',
		mix: 'I/O Mix',
		workload: 'Workload Shape'
	} as const;
	const PG_STAT_IO_DOCS = {
		reads: 'Number of read operations.',
		read_bytes: 'Total size of read operations in bytes.',
		read_time: 'Time spent waiting for read operations in milliseconds.',
		writes: 'Number of write operations.',
		write_bytes: 'Total size of write operations in bytes.',
		write_time: 'Time spent waiting for write operations in milliseconds.',
		writebacks: 'Units of size BLCKSZ that PostgreSQL requested the kernel write out to permanent storage.',
		writeback_time: 'Time spent waiting for writeback operations in milliseconds.',
		extends: 'Number of relation extend operations.',
		extend_bytes: 'Total size of relation extend operations in bytes.',
		extend_time: 'Time spent waiting for extend operations in milliseconds.',
		hits: 'Times a desired block was found in a shared buffer.',
		evictions: 'Times a block was written out from a shared or local buffer to make it available for another use.',
		reuses: 'Times an existing buffer in a size-limited ring buffer outside shared buffers was reused.',
		fsyncs: 'Number of fsync calls.',
		fsync_time: 'Time spent waiting for fsync operations in milliseconds.'
	} as const;
	const ioSource = (columns: string[]) => `Source: pg_stat_io.${columns.join(', pg_stat_io.')}.`;
	const ioRateDescription = (description: string, columns: string[]) => `${description} Shown as a per second delta for each backend_type/object/context series. ${ioSource(columns)}`;
	const ioRawDescription = (description: string, columns: string[]) => `${description} Raw view shows the cumulative delta since the first selected sample for each backend_type/object/context series. ${ioSource(columns)}`;
	const ioDerivedDescription = (description: string, uses: string) => `${description} Uses: ${uses}.`;

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
			description: ioRateDescription(PG_STAT_IO_DOCS.read_bytes, ['read_bytes']),
			kind: 'bytes',
			title: 'Top IO groups by read bytes over time',
			group: IO_GROUP.volume,
			category: 'raw',
			scoreFn: (entry) => entry.readBytes,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'read_bytes'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'read_bytes')
		},
		{
			key: 'reads',
			label: 'Reads',
			description: ioRateDescription(PG_STAT_IO_DOCS.reads, ['reads']),
			kind: 'count',
			title: 'Top IO groups by reads over time',
			group: IO_GROUP.operations,
			category: 'raw',
			scoreFn: (entry) => entry.reads,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'reads'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'reads')
		},
		{
			key: 'write_bytes',
			label: 'Write Bytes',
			description: ioRateDescription(PG_STAT_IO_DOCS.write_bytes, ['write_bytes']),
			kind: 'bytes',
			title: 'Top IO groups by write bytes over time',
			group: IO_GROUP.volume,
			category: 'raw',
			scoreFn: (entry) => entry.writeBytes,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'write_bytes'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'write_bytes')
		},
		{
			key: 'writes',
			label: 'Writes',
			description: ioRateDescription(PG_STAT_IO_DOCS.writes, ['writes']),
			kind: 'count',
			title: 'Top IO groups by writes over time',
			group: IO_GROUP.operations,
			category: 'raw',
			scoreFn: (entry) => entry.writes,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'writes'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'writes')
		},
		{
			key: 'extend_bytes',
			label: 'Extend Bytes',
			description: ioRateDescription(PG_STAT_IO_DOCS.extend_bytes, ['extend_bytes']),
			kind: 'bytes',
			title: 'Top IO groups by extend bytes over time',
			group: IO_GROUP.growth,
			category: 'raw',
			scoreFn: (entry) => entry.extendBytes,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'extend_bytes'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'extend_bytes')
		},
		{
			key: 'extends',
			label: 'Extends',
			description: ioRateDescription(PG_STAT_IO_DOCS.extends, ['extends']),
			kind: 'count',
			title: 'Top IO groups by extends over time',
			group: IO_GROUP.growth,
			category: 'raw',
			scoreFn: (entry) => entry.extends,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'extends'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'extends')
		},
		{
			key: 'hits',
			label: 'Hits',
			description: ioRateDescription(PG_STAT_IO_DOCS.hits, ['hits']),
			kind: 'count',
			title: 'Top IO groups by hits over time',
			group: IO_GROUP.buffer,
			category: 'raw',
			scoreFn: (entry) => entry.hits,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'hits'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'hits')
		},
		{
			key: 'evictions',
			label: 'Evictions',
			description: ioRateDescription(PG_STAT_IO_DOCS.evictions, ['evictions']),
			kind: 'count',
			title: 'Top IO groups by evictions over time',
			group: IO_GROUP.buffer,
			category: 'raw',
			scoreFn: (entry) => entry.evictions,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'evictions'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'evictions')
		},
		{
			key: 'fsyncs',
			label: 'FSyncs',
			description: ioRateDescription(PG_STAT_IO_DOCS.fsyncs, ['fsyncs']),
			kind: 'count',
			title: 'Top IO groups by fsyncs over time',
			group: IO_GROUP.sync,
			category: 'raw',
			scoreFn: (entry) => entry.fsyncs,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'fsyncs'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'fsyncs')
		},
		{
			key: 'read_time',
			label: 'Read Time (ms)',
			description: ioRateDescription(PG_STAT_IO_DOCS.read_time, ['read_time']),
			kind: 'duration_ms',
			title: 'Top IO groups by read time over time',
			group: IO_GROUP.latency,
			category: 'raw',
			scoreFn: (entry) => entry.readTime,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'read_time'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'read_time')
		},
		{
			key: 'write_time',
			label: 'Write Time (ms)',
			description: ioRateDescription(PG_STAT_IO_DOCS.write_time, ['write_time']),
			kind: 'duration_ms',
			title: 'Top IO groups by write time over time',
			group: IO_GROUP.latency,
			category: 'raw',
			scoreFn: (entry) => entry.writeTime,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'write_time'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'write_time')
		},
		{
			key: 'extend_time',
			label: 'Extend Time (ms)',
			description: ioRateDescription(PG_STAT_IO_DOCS.extend_time, ['extend_time']),
			kind: 'duration_ms',
			title: 'Top IO groups by extend time over time',
			group: IO_GROUP.growth,
			category: 'raw',
			scoreFn: (entry) => entry.extendTime,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'extend_time'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'extend_time')
		},
		{
			key: 'fsync_time',
			label: 'FSync Time (ms)',
			description: ioRateDescription(PG_STAT_IO_DOCS.fsync_time, ['fsync_time']),
			kind: 'duration_ms',
			title: 'Top IO groups by fsync time over time',
			group: IO_GROUP.sync,
			category: 'raw',
			scoreFn: (entry) => entry.fsyncTime,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'fsync_time'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'fsync_time')
		},
		{
			key: 'writebacks',
			label: 'Writebacks',
			description: ioRateDescription(PG_STAT_IO_DOCS.writebacks, ['writebacks']),
			kind: 'count',
			title: 'Top IO groups by writebacks over time',
			group: IO_GROUP.sync,
			category: 'raw',
			scoreFn: (entry) => entry.writebacks,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'writebacks'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'writebacks')
		},
		{
			key: 'reuses',
			label: 'Reuses',
			description: ioRateDescription(PG_STAT_IO_DOCS.reuses, ['reuses']),
			kind: 'count',
			title: 'Top IO groups by buffer reuses over time',
			group: IO_GROUP.buffer,
			category: 'raw',
			scoreFn: (entry) => entry.reuses,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'reuses'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'reuses')
		},
		{
			key: 'avg_read_time_ms',
			label: 'Avg Read Time (ms)',
			description: ioDerivedDescription('Average read wait time per read operation; useful for spotting read latency roots by backend/object/context.', 'read_time / reads'),
			kind: 'duration_ms',
			title: 'Average time per read operation over time',
			group: IO_GROUP.latency,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.readTime, entry.reads),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'read_time'), deltaAt(groupRows, index, 'reads'))
		},
		{
			key: 'avg_write_time_ms',
			label: 'Avg Write Time (ms)',
			description: ioDerivedDescription('Average write wait time per write operation; high values point to write path latency.', 'write_time / writes'),
			kind: 'duration_ms',
			title: 'Average time per write operation over time',
			group: IO_GROUP.latency,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.writeTime, entry.writes),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'write_time'), deltaAt(groupRows, index, 'writes'))
		},
		{
			key: 'avg_fsync_time_ms',
			label: 'Avg FSync Time (ms)',
			description: ioDerivedDescription('Average fsync wait time per fsync call; high values indicate sync latency or storage flush pressure.', 'fsync_time / fsyncs'),
			kind: 'duration_ms',
			title: 'Average time per fsync call over time',
			group: IO_GROUP.sync,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.fsyncTime, entry.fsyncs),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'fsync_time'), deltaAt(groupRows, index, 'fsyncs'))
		},
		{
			key: 'read_miss_ratio',
			label: 'Read Miss Ratio',
			description: ioDerivedDescription('Share of buffer access that required a read operation; rising values suggest cache misses or cold reads.', 'reads / (reads + hits)'),
			kind: 'percent',
			title: 'Cache miss rate (reads / (reads + hits)) over time — lower is better',
			group: IO_GROUP.buffer,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.reads, sum([entry.reads, entry.hits])),
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'reads', ['reads', 'hits'])
		},
		{
			key: 'cache_hit_rate',
			label: 'Cache Hit Rate',
			description: ioDerivedDescription('Share of desired blocks found in shared buffers; lower values point toward cold reads or working-set pressure.', 'hits / (hits + reads)'),
			kind: 'percent',
			title: 'Buffer cache hit rate by IO group over time',
			group: IO_GROUP.buffer,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.hits, sum([entry.hits, entry.reads])),
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'hits', ['hits', 'reads'])
		},
		{
			key: 'writeback_time',
			label: 'Writeback Time (ms)',
			description: ioRateDescription(PG_STAT_IO_DOCS.writeback_time, ['writeback_time']),
			kind: 'duration_ms',
			title: 'Top IO groups by writeback time over time',
			group: IO_GROUP.sync,
			category: 'raw',
			scoreFn: (entry) => entry.writebackTime,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'writeback_time'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'writeback_time')
		},
		{
			key: 'avg_writeback_time_ms',
			label: 'Avg Writeback Time (ms)',
			description: ioDerivedDescription('Average time spent waiting for kernel writeback requests; useful for OS page-cache pressure.', 'writeback_time / writebacks'),
			kind: 'duration_ms',
			title: 'Average time per writeback operation over time',
			group: IO_GROUP.sync,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.writebackTime, entry.writebacks),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'writeback_time'), deltaAt(groupRows, index, 'writebacks'))
		},
		{
			key: 'avg_extend_time_ms',
			label: 'Avg Extend Time (ms)',
			description: ioDerivedDescription('Average wait time per relation extend operation; high values can make table or index growth expensive.', 'extend_time / extends'),
			kind: 'duration_ms',
			title: 'Average time per extend operation over time',
			group: IO_GROUP.growth,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.extendTime, entry.extends),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'extend_time'), deltaAt(groupRows, index, 'extends'))
		},
		{
			key: 'avg_read_size',
			label: 'Avg Read Size',
			description: ioDerivedDescription('Average bytes per read operation; helps distinguish many small reads from larger read batches.', 'read_bytes / reads'),
			kind: 'bytes',
			title: 'Average bytes per read operation over time',
			group: IO_GROUP.volume,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.readBytes, entry.reads),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'read_bytes'), deltaAt(groupRows, index, 'reads'))
		},
		{
			key: 'avg_write_size',
			label: 'Avg Write Size',
			description: ioDerivedDescription('Average bytes per write operation; helps distinguish many small writes from larger write batches.', 'write_bytes / writes'),
			kind: 'bytes',
			title: 'Average bytes per write operation over time',
			group: IO_GROUP.volume,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.writeBytes, entry.writes),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'write_bytes'), deltaAt(groupRows, index, 'writes'))
		},
		{
			key: 'avg_extend_size',
			label: 'Avg Extend Size',
			description: ioDerivedDescription('Average bytes per relation extend operation; indicates relation growth chunk size.', 'extend_bytes / extends'),
			kind: 'bytes',
			title: 'Average bytes per extend operation over time',
			group: IO_GROUP.growth,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.extendBytes, entry.extends),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'extend_bytes'), deltaAt(groupRows, index, 'extends'))
		},
		{
			key: 'eviction_ratio',
			label: 'Eviction Ratio',
			description: ioDerivedDescription('Evictions normalized by buffer access; high values indicate buffer churn or shared buffer pressure.', 'evictions / (hits + reads)'),
			kind: 'percent',
			title: 'Evictions as a fraction of total buffer accesses (reads + hits) — high means buffer pressure',
			group: IO_GROUP.buffer,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.evictions, sum([entry.hits, entry.reads])),
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'evictions', ['hits', 'reads'])
		},
		{
			key: 'evictions_per_write',
			label: 'Evictions / Write',
			description: ioDerivedDescription('Evictions per write operation; useful when backend writes appear coupled with buffer replacement pressure.', 'evictions / writes'),
			kind: 'count',
			title: 'Evictions per write operation over time',
			group: IO_GROUP.buffer,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.evictions, entry.writes),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'evictions'), deltaAt(groupRows, index, 'writes'))
		},
		{
			key: 'writeback_ratio',
			label: 'Writebacks / Write',
			description: ioDerivedDescription('Writeback requests per write operation; spikes can indicate dirty-page or OS page-cache pressure.', 'writebacks / writes'),
			kind: 'count',
			title: 'Writeback operations per write — spikes indicate OS page cache pressure',
			group: IO_GROUP.sync,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.writebacks, entry.writes),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'writebacks'), deltaAt(groupRows, index, 'writes'))
		},
		{
			key: 'fsyncs_per_write',
			label: 'FSyncs / Write',
			description: ioDerivedDescription('Fsync calls per write operation; high values, especially for client backends, can indicate sync/checkpoint path pressure.', 'fsyncs / writes'),
			kind: 'count',
			title: 'Fsync calls per write operation over time',
			group: IO_GROUP.sync,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.fsyncs, entry.writes),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'fsyncs'), deltaAt(groupRows, index, 'writes'))
		},
		{
			key: 'fsync_time_per_write',
			label: 'FSync Time / Write',
			description: ioDerivedDescription('Fsync wait time normalized by writes; highlights sync cost paid per write operation.', 'fsync_time / writes'),
			kind: 'duration_ms',
			title: 'Fsync time per write operation over time',
			group: IO_GROUP.sync,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.fsyncTime, entry.writes),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'fsync_time'), deltaAt(groupRows, index, 'writes'))
		},
		{
			key: 'write_byte_share',
			label: 'Write Byte Share',
			description: ioDerivedDescription('Write-like bytes as a share of total IO bytes; helps separate read-heavy from write/growth-heavy pressure.', '(write_bytes + extend_bytes) / (read_bytes + write_bytes + extend_bytes)'),
			kind: 'percent',
			title: 'Write-like bytes as share of total IO bytes over time',
			group: IO_GROUP.mix,
			category: 'derived',
			scoreFn: (entry) => safeRatio(sum([entry.writeBytes, entry.extendBytes]), sum([entry.readBytes, entry.writeBytes, entry.extendBytes])),
			seriesValueAt: (groupRows, index) => safeRatio(sumDeltaAt(groupRows, index, ['write_bytes', 'extend_bytes']), sumDeltaAt(groupRows, index, ['read_bytes', 'write_bytes', 'extend_bytes']))
		},
		{
			key: 'reuse_ratio',
			label: 'Reuse Ratio',
			description: ioDerivedDescription('Ring-buffer reuses normalized by IO operations; useful for bulkread, bulkwrite, and vacuum contexts.', 'reuses / (reads + writes + extends)'),
			kind: 'percent',
			title: 'Buffer reuse ratio over time',
			group: IO_GROUP.buffer,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.reuses, sum([entry.reads, entry.writes, entry.extends])),
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'reuses'), sumDeltaAt(groupRows, index, ['reads', 'writes', 'extends']))
		},
		{
			key: 'extend_vs_write_ratio',
			label: 'Extend vs Write Ratio',
			description: ioDerivedDescription('Relation extends as a share of write-like operations; high values mean workload time is tied to growth/allocation.', 'extends / (writes + extends)'),
			kind: 'percent',
			title: 'Extends as a fraction of write-like ops (writes + extends) — high means heavy table growth',
			group: IO_GROUP.growth,
			category: 'derived',
			scoreFn: (entry) => safeRatio(entry.extends, sum([entry.writes, entry.extends])),
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'extends', ['writes', 'extends'])
		}
	]);

	// IO Time Mix — aggregated across all IO groups, shows fraction of total IO time per component
	const ioTimeMixSeries: TelemetrySeries[] = (() => {
		const timeFields = [
			{ label: 'read', field: 'read_time' },
			{ label: 'write', field: 'write_time' },
			{ label: 'extend', field: 'extend_time' },
			{ label: 'fsync', field: 'fsync_time' },
			{ label: 'writeback', field: 'writeback_time' }
		];
		const tsMap = new Map<string, SnapshotRow[]>();
		for (const row of rows) {
			const ts = String(row._collected_at);
			if (!tsMap.has(ts)) tsMap.set(ts, []);
			tsMap.get(ts)!.push(row);
		}
		const sortedTs = [...tsMap.keys()].sort();
		if (sortedTs.length < 2) return [];
		const baseRows = tsMap.get(sortedTs[0])!;
		const baseTotals = new Map(timeFields.map((f) => [f.field, sum(baseRows.map((r) => toNumber(r[f.field]))) ?? 0]));
		return timeFields
			.map(({ label, field }, colorIdx) => {
				const points = sortedTs
					.map((ts) => {
						const tsRows = tsMap.get(ts)!;
						const t = relTime(tsRows[0], runStartMs);
						if (t === null) return null;
						const deltaThis = (sum(tsRows.map((r) => toNumber(r[field]))) ?? 0) - (baseTotals.get(field) ?? 0);
						const deltaAll = sum(
							timeFields.map((f) => (sum(tsRows.map((r) => toNumber(r[f.field]))) ?? 0) - (baseTotals.get(f.field) ?? 0))
						);
						const ratio = safeRatio(deltaThis, deltaAll);
						if (ratio === null || !Number.isFinite(ratio)) return null;
						return { t, v: ratio } as TelemetrySeriesPoint;
					})
					.filter((p): p is TelemetrySeriesPoint => p !== null);
				if (points.length === 0) return null;
				return { label, color: COLORS[colorIdx % COLORS.length], points } as TelemetrySeries;
			})
			.filter((s): s is TelemetrySeries => s !== null);
	})();
	// Aggregate cross-database derived metrics — sum a field across all IO groups at each timestamp,
	// then normalise by a database-level denominator aligned by timestamp.
	const sortedDbRows = [...databaseRows].sort((a, b) => (toMs(String(a._collected_at)) ?? 0) - (toMs(String(b._collected_at)) ?? 0));
	const buildIoCrossDbSeries = (
		ioField: string,
		denominatorAtTs: (ts: string) => number | null,
		label: string,
		description: string,
		colorIdx: number
	): TelemetrySeries[] => {
		const tsMap = new Map<string, SnapshotRow[]>();
		for (const row of rows) {
			const ts = String(row._collected_at);
			if (!tsMap.has(ts)) tsMap.set(ts, []);
			tsMap.get(ts)!.push(row);
		}
		const sortedTs = [...tsMap.keys()].sort();
		if (sortedTs.length < 2) return [];
		const baseRows = tsMap.get(sortedTs[0])!;
		const baseTotal = sum(baseRows.map((r) => toNumber(r[ioField]))) ?? 0;
		const points = sortedTs
			.map((ts) => {
				const tsRows = tsMap.get(ts)!;
				const t = relTime(tsRows[0], runStartMs);
				if (t === null) return null;
				const currentTotal = sum(tsRows.map((r) => toNumber(r[ioField]))) ?? 0;
				const value = safeRatio(currentTotal - baseTotal, denominatorAtTs(ts));
				if (value === null || !Number.isFinite(value)) return null;
				return { t, v: value } as TelemetrySeriesPoint;
			})
			.filter((p): p is TelemetrySeriesPoint => p !== null);
		if (points.length === 0) return [];
		return [{ label, color: COLORS[colorIdx % COLORS.length], points, description }];
	};
	const dbDeltaAtTs = (ts: string, fields: string[]): number | null => {
		if (sortedDbRows.length === 0) return null;
		const tsMs = toMs(ts);
		let dbIdx = -1;
		for (let i = 0; i < sortedDbRows.length; i++) {
			const dbTs = toMs(String(sortedDbRows[i]._collected_at));
			if (tsMs !== null && dbTs !== null && dbTs <= tsMs) dbIdx = i;
		}
		if (dbIdx < 0) dbIdx = 0;
		return sumDeltaAt(sortedDbRows, dbIdx, fields);
	};
	const ioCrossDbDesc = (description: string, uses: string) => `${description} Uses: ${uses}.`;
	const ioWorkloadMetrics: TelemetryChartMetric[] = [];
	const pushIoWorkload = (m: TelemetryChartMetric) => { if (m.series.length > 0) ioWorkloadMetrics.push(m); };

	pushIoWorkload({
		key: 'io_read_bytes_per_tx',
		label: 'Read Bytes / Tx',
		description: ioCrossDbDesc('Physical read bytes per transaction, aggregated across all IO groups; a design with better index coverage reads fewer bytes per unit of work.', 'Σ read_bytes / transactions'),
		kind: 'bytes',
		title: 'Physical read bytes per transaction over time',
		group: IO_GROUP.workload,
		category: 'derived',
		series: buildIoCrossDbSeries('read_bytes', (ts) => dbDeltaAtTs(ts, ['xact_commit', 'xact_rollback']), 'read bytes / tx', ioCrossDbDesc('Physical read bytes per transaction, aggregated across all IO groups; a design with better index coverage reads fewer bytes per unit of work.', 'Σ read_bytes / transactions'), 0)
	});

	pushIoWorkload({
		key: 'io_read_bytes_per_row_fetched',
		label: 'Read Bytes / Row Fetched',
		description: ioCrossDbDesc('Physical read bytes per row delivered to queries; captures read amplification from page layout, index coverage, and heap fetch overhead — the most direct IO comparison metric for table designs.', 'Σ read_bytes / tup_fetched'),
		kind: 'bytes',
		title: 'Physical read bytes per row fetched over time',
		group: IO_GROUP.workload,
		category: 'derived',
		series: buildIoCrossDbSeries('read_bytes', (ts) => dbDeltaAtTs(ts, ['tup_fetched']), 'read bytes / row fetched', ioCrossDbDesc('Physical read bytes per row delivered to queries; captures read amplification from page layout, index coverage, and heap fetch overhead — the most direct IO comparison metric for table designs.', 'Σ read_bytes / tup_fetched'), 1)
	});

	pushIoWorkload({
		key: 'io_read_time_ratio',
		label: 'Read Time / Active Time',
		description: ioCrossDbDesc('Fraction of active query execution time spent waiting on reads; directly answers "is IO hurting query performance?" rather than just how much IO volume there is.', 'Σ read_time / active_time'),
		kind: 'percent',
		title: 'IO read time as a fraction of active query time over time',
		group: IO_GROUP.workload,
		category: 'derived',
		series: buildIoCrossDbSeries('read_time', (ts) => dbDeltaAtTs(ts, ['active_time']), 'read time / active time', ioCrossDbDesc('Fraction of active query execution time spent waiting on reads; directly answers "is IO hurting query performance?" rather than just how much IO volume there is.', 'Σ read_time / active_time'), 2)
	});

	pushIoWorkload({
		key: 'io_evictions_per_tx',
		label: 'Evictions / Tx',
		description: ioCrossDbDesc('Buffer evictions per transaction, aggregated across all IO groups; workload-normalised buffer churn for cross-run comparison independent of run duration.', 'Σ evictions / transactions'),
		kind: 'count',
		title: 'Buffer evictions per transaction over time',
		group: IO_GROUP.workload,
		category: 'derived',
		series: buildIoCrossDbSeries('evictions', (ts) => dbDeltaAtTs(ts, ['xact_commit', 'xact_rollback']), 'evictions / tx', ioCrossDbDesc('Buffer evictions per transaction, aggregated across all IO groups; workload-normalised buffer churn for cross-run comparison independent of run duration.', 'Σ evictions / transactions'), 3)
	});

	const allChartMetrics: TelemetryChartMetric[] = [
		...chartMetrics,
		...(ioTimeMixSeries.length > 0
			? [{
				key: 'io_time_mix',
				label: 'IO Time Mix',
				description: ioDerivedDescription('Share of total IO wait time spent in each wait component, aggregated across IO groups.', 'each *_time / total IO time'),
				kind: 'percent' as const,
				title: 'IO time breakdown: fraction of total IO time per component',
				group: IO_GROUP.mix,
				category: 'derived' as const,
				series: ioTimeMixSeries
			}]
			: []),
		...ioWorkloadMetrics
	];

	return {
		key: 'io',
		label: 'IO',
		status: 'ok',
		summary: [],
		chartTitle: allChartMetrics[0]?.title ?? 'Top IO groups by read bytes over time',
		chartSeries: allChartMetrics[0]?.series ?? [],
		chartMetrics: allChartMetrics,
		defaultChartMetricKey: allChartMetrics[0]?.key,
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
			category: 'raw',
			scoreFn: (entry) => entry.writes,
			seriesValueAt: (groupRows, index) => safeRatio(sumDeltaAt(groupRows, index, ['n_tup_ins', 'n_tup_upd', 'n_tup_del']), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['n_tup_ins', 'n_tup_upd', 'n_tup_del'])
		},
		{
			key: 'seq_tup_read',
			label: 'Seq Tuples Read',
			kind: 'count',
			title: 'Top tables by rows returned from sequential scans over time',
			category: 'raw',
			scoreFn: (entry) => entry.seqTupRead,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'seq_tup_read'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'seq_tup_read')
		},
		{
			key: 'idx_tup_fetch',
			label: 'Idx Tuples Fetched',
			kind: 'count',
			title: 'Top tables by rows fetched via index scans over time',
			category: 'raw',
			scoreFn: (entry) => entry.idxTupFetch,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_tup_fetch'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_tup_fetch')
		},
		{
			key: 'dead_tuple_growth',
			label: 'Dead Tuple Growth',
			kind: 'count',
			title: 'Top tables by dead tuple growth over time',
			category: 'raw',
			scoreFn: (entry) => entry.deadTupleGrowth,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'n_dead_tup'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'n_dead_tup')
		},
		{
			key: 'seq_scan_ratio',
			label: '⟳ Seq Scan Ratio',
			kind: 'percent',
			title: 'Top tables by seq scan ratio over time',
			category: 'derived',
			scoreFn: (entry) => entry.seqScanRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'seq_scan', ['seq_scan', 'idx_scan'])
		},
		{
			key: 'hot_update_ratio',
			label: '⟳ HOT Update Ratio',
			kind: 'percent',
			title: 'Top tables by HOT update ratio over time',
			category: 'derived',
			scoreFn: (entry) => entry.hotRatio,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'n_tup_hot_upd'), deltaAt(groupRows, index, 'n_tup_upd'))
		},
		{
			key: 'dead_tuple_ratio',
			label: '⟳ Dead Tuple Ratio',
			kind: 'percent',
			title: 'Dead tuple ratio over time (dead / total rows) — autovacuum backlog indicator',
			category: 'derived',
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
			category: 'derived',
			scoreFn: (entry) => entry.writes,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'idx_scan', ['seq_scan', 'idx_scan'])
		},
		{
			key: 'vacuum_activity',
			label: '⟳ Vacuum Activity',
			kind: 'count',
			title: 'Vacuum + autovacuum runs per table over time',
			category: 'derived',
			scoreFn: (entry) => entry.vacuumActivity,
			seriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['vacuum_count', 'autovacuum_count'])
		},
		{
			key: 'newpage_update_ratio',
			label: '⟳ New-Page Update Ratio',
			kind: 'percent',
			title: 'Share of updates that moved tuples to a new page (bloat indicator, PG16+)',
			category: 'derived',
			scoreFn: (entry) => entry.newpageUpd,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'n_tup_newpage_upd'), deltaAt(groupRows, index, 'n_tup_upd'))
		},
		{
			key: 'rows_per_seq_scan',
			label: '⟳ Rows / Seq Scan',
			kind: 'count',
			title: 'Average rows returned per sequential scan over time — large values on large tables suggest missing indexes',
			category: 'derived',
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
			category: 'raw',
			scoreFn: (entry) => entry.idxScans,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_scan'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_scan')
		},
		{
			key: 'idx_tup_read',
			label: 'Tuples Read',
			kind: 'count',
			title: 'Top indexes by tuples read over time',
			category: 'raw',
			scoreFn: (entry) => entry.idxRead,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_tup_read'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_tup_read')
		},
		{
			key: 'idx_tup_fetch',
			label: 'Tuples Fetch',
			kind: 'count',
			title: 'Top indexes by tuples fetched over time',
			category: 'raw',
			scoreFn: (entry) => entry.idxFetch,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_tup_fetch'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_tup_fetch')
		},
		{
			key: 'selectivity',
			label: '⟳ Selectivity',
			kind: 'percent',
			title: 'Top indexes by selectivity over time',
			category: 'derived',
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
			category: 'raw',
			scoreFn: (entry) => entry.heapActivity,
			seriesValueAt: (groupRows, index) => safeRatio(sumDeltaAt(groupRows, index, ['heap_blks_read', 'heap_blks_hit']), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['heap_blks_read', 'heap_blks_hit'])
		},
		{
			key: 'heap_hits',
			label: 'Heap Hits',
			kind: 'count',
			title: 'Top tables by heap hits over time',
			category: 'raw',
			scoreFn: (entry) => entry.heapHits,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'heap_blks_hit'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'heap_blks_hit')
		},
		{
			key: 'heap_reads',
			label: 'Heap Reads',
			kind: 'count',
			title: 'Top tables by heap reads over time',
			category: 'raw',
			scoreFn: (entry) => entry.heapReads,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'heap_blks_read'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'heap_blks_read')
		},
		{
			key: 'toast_reads',
			label: 'TOAST Reads',
			kind: 'count',
			title: 'Top tables by TOAST reads over time',
			category: 'raw',
			scoreFn: (entry) => entry.toasts,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'toast_blks_read'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'toast_blks_read')
		},
		{
			key: 'idx_blks_read',
			label: 'Idx Blocks Read',
			kind: 'count',
			title: 'Top tables by index block reads over time',
			category: 'raw',
			scoreFn: (entry) => entry.idxReads,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_blks_read'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_blks_read')
		},
		{
			key: 'heap_hit_ratio',
			label: '⟳ Heap Hit Ratio',
			kind: 'percent',
			title: 'Top tables by heap hit ratio over time',
			category: 'derived',
			scoreFn: (entry) => entry.heapHitRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'heap_blks_hit', ['heap_blks_hit', 'heap_blks_read'])
		},
		{
			key: 'idx_hit_ratio',
			label: '⟳ Idx Hit Ratio',
			kind: 'percent',
			title: 'Per-table index cache hit ratio over time',
			category: 'derived',
			scoreFn: (entry) => entry.idxHitRatio,
			seriesValueAt: (groupRows, index) => ratioAt(groupRows, index, 'idx_blks_hit', ['idx_blks_hit', 'idx_blks_read'])
		},
		{
			key: 'overall_hit_ratio',
			label: '⟳ Overall Hit Ratio',
			kind: 'percent',
			title: 'Combined cache hit ratio across heap + index + TOAST blocks per table over time',
			category: 'derived',
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
			category: 'raw',
			scoreFn: (entry) => entry.idxReads,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_blks_read'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_blks_read')
		},
		{
			key: 'idx_blks_hit',
			label: 'Idx Blocks Hit',
			kind: 'count',
			title: 'Top indexes by index block hits (from shared buffers) over time',
			category: 'raw',
			scoreFn: (entry) => entry.idxHits,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'idx_blks_hit'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'idx_blks_hit')
		},
		{
			key: 'idx_hit_ratio',
			label: '⟳ Idx Hit Ratio',
			kind: 'percent',
			title: 'Top indexes by hit ratio over time',
			category: 'derived',
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
			category: 'raw',
			scoreFn: (entry) => entry.sequenceActivity,
			seriesValueAt: (groupRows, index) => safeRatio(sumDeltaAt(groupRows, index, ['blks_read', 'blks_hit']), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => sumDeltaAt(groupRows, index, ['blks_read', 'blks_hit'])
		},
		{
			key: 'sequence_hits',
			label: 'Sequence Hits',
			kind: 'count',
			title: 'Top sequences by block hits over time',
			category: 'raw',
			scoreFn: (entry) => entry.sequenceHits,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'blks_hit'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'blks_hit')
		},
		{
			key: 'sequence_reads',
			label: 'Sequence Reads',
			kind: 'count',
			title: 'Top sequences by block reads over time',
			category: 'raw',
			scoreFn: (entry) => entry.sequenceReads,
			seriesValueAt: (groupRows, index) => safeRatio(deltaAt(groupRows, index, 'blks_read'), elapsedSecondsAt(groupRows, index)),
			rawSeriesValueAt: (groupRows, index) => deltaAt(groupRows, index, 'blks_read')
		},
		{
			key: 'sequence_hit_ratio',
			label: '⟳ Sequence Hit Ratio',
			kind: 'percent',
			title: 'Top sequences by hit ratio over time',
			category: 'derived',
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

function buildCheckpointerSection(rows: SnapshotRow[], runStartMs: number, databaseRows: SnapshotRow[]): TelemetrySection {
	const numTimed = delta(rows, 'num_timed');
	const numRequested = delta(rows, 'num_requested');
	const totalCheckpoints = sum([numTimed, numRequested]);
	const writeTime = delta(rows, 'write_time');
	const syncTime = delta(rows, 'sync_time');
	const buffersWritten = delta(rows, 'buffers_written');
	const slruWritten = delta(rows, 'slru_written');
	const restartpointsDone = delta(rows, 'restartpoints_done');
	const checkpointPressure = safeRatio(numRequested, totalCheckpoints);
	const avgWriteTimePerCkpt = safeRatio(writeTime, totalCheckpoints);
	const avgSyncTimePerCkpt = safeRatio(syncTime, totalCheckpoints);
	const avgTotalIoPerCkpt = safeRatio(sum([writeTime, syncTime]), totalCheckpoints);
	const syncWriteRatio = safeRatio(syncTime, writeTime);
	const buffersPerCkpt = safeRatio(buffersWritten, totalCheckpoints);
	const writeTimePerBuffer = safeRatio(writeTime, buffersWritten);
	const restartpointRatio = safeRatio(restartpointsDone, sum([totalCheckpoints, restartpointsDone]));
	const transactions = sum([delta(databaseRows, 'xact_commit'), delta(databaseRows, 'xact_rollback')]);
	const checkpointsPerKTx = (() => {
		const value = safeRatio(totalCheckpoints, transactions);
		return value === null ? null : value * 1000;
	})();
	const buffersWrittenPerTx = safeRatio(buffersWritten, transactions);
	const writeTimePerTx = safeRatio(writeTime, transactions);

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

	const ckptChartMetrics: TelemetryChartMetric[] = [];
	const CKPT_GROUP = {
		frequency: 'Frequency',
		writeIo: 'Write I/O',
		sync: 'Sync',
		pressure: 'Pressure',
		workload: 'Workload Shape'
	} as const;
	const PG_STAT_CHECKPOINTER_DOCS = {
		num_timed: 'Number of scheduled checkpoints that have been performed.',
		num_requested: 'Number of requested checkpoints that have been performed.',
		restartpoints_timed: 'Number of scheduled restartpoints that have been performed.',
		restartpoints_req: 'Number of requested restartpoints performed.',
		restartpoints_done: 'Number of restartpoints that have been performed.',
		write_time: 'Total amount of time spent in the portion of checkpoint processing where files are written to disk, in milliseconds.',
		sync_time: 'Total amount of time spent in the portion of checkpoint processing where files are synchronized to disk, in milliseconds.',
		buffers_written: 'Number of buffers written during checkpoints and restartpoints.',
		slru_written: 'Number of SLRU pages written during checkpoints and restartpoints.'
	} as const;
	const ckptSource = (columns: string[]) => `Source: pg_stat_checkpointer.${columns.join(', pg_stat_checkpointer.')}.`;
	const ckptRateDescription = (description: string, columns: string[]) => `${description} Shown as a per second delta. ${ckptSource(columns)}`;
	const ckptRawDescription = (description: string, columns: string[]) => `${description} Raw view shows the cumulative delta since the first selected sample. ${ckptSource(columns)}`;
	const ckptDerivedDescription = (description: string, uses: string) => `${description} Uses: ${uses}.`;
	const pushCkpt = (m: TelemetryChartMetric | null, group: string) => {
		if (m && (m.series.length > 0 || (m.rawSeries?.length ?? 0) > 0)) ckptChartMetrics.push({ ...m, group });
	};
	const totalCheckpointsAt = (r: SnapshotRow[], i: number) => sum([deltaAt(r, i, 'num_requested'), deltaAt(r, i, 'num_timed')]);
	const transactionsAt = (ckptRows: SnapshotRow[], ckptIndex: number): number | null => {
		if (databaseRows.length === 0) return null;
		const ckptTs = toMs(String(ckptRows[ckptIndex]?._collected_at ?? ''));
		let txIndex = -1;
		for (let index = 0; index < databaseRows.length; index++) {
			const txTs = toMs(String(databaseRows[index]._collected_at));
			if (ckptTs !== null && txTs !== null && txTs <= ckptTs) txIndex = index;
		}
		if (txIndex < 0) txIndex = Math.min(ckptIndex, databaseRows.length - 1);
		return sumDeltaAt(databaseRows, txIndex, ['xact_commit', 'xact_rollback']);
	};

	// Frequency
	const ckptCountsRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'requested/s', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.num_requested, ['num_requested']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'num_requested'), elapsedSecondsAt(r, i)) },
		{ label: 'timed/s', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.num_timed, ['num_timed']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'num_timed'), elapsedSecondsAt(r, i)) }
	]);
	const ckptCountsRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'requested', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.num_requested, ['num_requested']), valueFn: (row) => toNumber(row.num_requested) },
		{ label: 'timed', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.num_timed, ['num_timed']), valueFn: (row) => toNumber(row.num_timed) }
	]);
	pushCkpt({ key: 'checkpoint_counts', label: 'Checkpoints', description: 'Requested and timed checkpoint counts from pg_stat_checkpointer.', kind: 'count', title: 'Checkpoint counts over time', category: 'raw', series: ckptCountsRate, rawSeries: ckptCountsRaw }, CKPT_GROUP.frequency);

	const restartpointsRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'restartpoints done/s', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.restartpoints_done, ['restartpoints_done']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'restartpoints_done'), elapsedSecondsAt(r, i)) }
	]);
	const restartpointsRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'restartpoints done', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.restartpoints_done, ['restartpoints_done']), valueFn: (row) => toNumber(row.restartpoints_done) },
		{ label: 'restartpoints timed', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.restartpoints_timed, ['restartpoints_timed']), valueFn: (row) => toNumber(row.restartpoints_timed) },
		{ label: 'restartpoints req', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.restartpoints_req, ['restartpoints_req']), valueFn: (row) => toNumber(row.restartpoints_req) }
	]);
	pushCkpt({ key: 'restartpoints', label: 'Restartpoints', description: ckptRawDescription('Restartpoints performed (standby-equivalent of checkpoints).', ['restartpoints_done', 'restartpoints_timed', 'restartpoints_req']), kind: 'count', title: 'Restartpoints over time', category: 'raw', series: restartpointsRate, rawSeries: restartpointsRaw }, CKPT_GROUP.frequency);

	// Write I/O
	const writeTimeRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'write time (ms)/s', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.write_time, ['write_time']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'write_time'), elapsedSecondsAt(r, i)) }
	]);
	const writeTimeRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'write time (ms)', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.write_time, ['write_time']), valueFn: (row) => toNumber(row.write_time) }
	]);
	pushCkpt({ key: 'checkpoint_write_time', label: 'Write Time', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.write_time, ['write_time']), kind: 'duration_ms', title: 'Checkpoint write time over time', category: 'raw', series: writeTimeRate, rawSeries: writeTimeRaw }, CKPT_GROUP.writeIo);

	const buffersWrittenRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers written/s', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.buffers_written, ['buffers_written']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_written'), elapsedSecondsAt(r, i)) }
	]);
	const buffersWrittenRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'buffers written', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.buffers_written, ['buffers_written']), valueFn: (row) => toNumber(row.buffers_written) },
		{ label: 'slru written', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.slru_written, ['slru_written']), valueFn: (row) => toNumber(row.slru_written) }
	]);
	pushCkpt({ key: 'checkpoint_buffers', label: 'Buffers Written', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.buffers_written, ['buffers_written', 'slru_written']), kind: 'count', title: 'Checkpoint buffers written over time', category: 'raw', series: buffersWrittenRate, rawSeries: buffersWrittenRaw }, CKPT_GROUP.writeIo);

	// Sync
	const syncTimeRate = buildDerivedSeries(rows, runStartMs, [
		{ label: 'sync time (ms)/s', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.sync_time, ['sync_time']), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sync_time'), elapsedSecondsAt(r, i)) }
	]);
	const syncTimeRaw = buildMetricSeries(rows, runStartMs, [
		{ label: 'sync time (ms)', description: ckptRawDescription(PG_STAT_CHECKPOINTER_DOCS.sync_time, ['sync_time']), valueFn: (row) => toNumber(row.sync_time) }
	]);
	pushCkpt({ key: 'checkpoint_sync_time', label: 'Sync Time', description: ckptRateDescription(PG_STAT_CHECKPOINTER_DOCS.sync_time, ['sync_time']), kind: 'duration_ms', title: 'Checkpoint sync time over time', category: 'raw', series: syncTimeRate, rawSeries: syncTimeRaw }, CKPT_GROUP.sync);

	// Pressure (derived)
	const pressureSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'pressure (% forced)', description: ckptDerivedDescription('Share of checkpoints that were forced (requested) rather than scheduled; high values indicate write pressure is causing checkpoints to be demanded before their scheduled time.', 'num_requested / (num_requested + num_timed)'), seriesValueAt: (r, i) => ratioAt(r, i, 'num_requested', ['num_requested', 'num_timed']) }
	]);
	pushCkpt({ key: 'checkpoint_pressure', label: 'Pressure', description: ckptDerivedDescription('Share of checkpoints that were forced (requested) rather than scheduled; high values indicate write pressure is causing checkpoints to be demanded before their scheduled time.', 'num_requested / (num_requested + num_timed)'), kind: 'percent', title: 'Checkpoint pressure (% forced) over time', category: 'derived', series: pressureSeries }, CKPT_GROUP.pressure);

	const avgWriteTimeSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'avg write time (ms)', description: ckptDerivedDescription('Average time spent writing dirty buffers per checkpoint; high values indicate the disk write path is becoming a bottleneck during checkpoints.', 'write_time / (num_requested + num_timed)'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'write_time'), totalCheckpointsAt(r, i)) }
	]);
	pushCkpt({ key: 'checkpoint_avg_write_ms', label: 'Avg Write Time', description: ckptDerivedDescription('Average time spent writing dirty buffers per checkpoint; high values indicate the disk write path is becoming a bottleneck during checkpoints.', 'write_time / (num_requested + num_timed)'), kind: 'duration_ms', title: 'Avg write time per checkpoint over time', category: 'derived', series: avgWriteTimeSeries }, CKPT_GROUP.pressure);

	const avgSyncTimeSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'avg sync time (ms)', description: ckptDerivedDescription('Average time spent flushing dirty buffers to durable storage per checkpoint; high values indicate fsync or storage flush latency.', 'sync_time / (num_requested + num_timed)'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sync_time'), totalCheckpointsAt(r, i)) }
	]);
	pushCkpt({ key: 'checkpoint_avg_sync_ms', label: 'Avg Sync Time', description: ckptDerivedDescription('Average time spent flushing dirty buffers to durable storage per checkpoint; high values indicate fsync or storage flush latency.', 'sync_time / (num_requested + num_timed)'), kind: 'duration_ms', title: 'Avg sync time per checkpoint over time', category: 'derived', series: avgSyncTimeSeries }, CKPT_GROUP.pressure);

	const avgTotalIoSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'avg total I/O (ms)', description: ckptDerivedDescription('Average total I/O time (write + sync) per checkpoint; the combined cost of a checkpoint flush cycle.', '(write_time + sync_time) / (num_requested + num_timed)'), seriesValueAt: (r, i) => safeRatio(sum([deltaAt(r, i, 'write_time'), deltaAt(r, i, 'sync_time')]), totalCheckpointsAt(r, i)) }
	]);
	pushCkpt({ key: 'checkpoint_avg_total_io_ms', label: 'Avg Total I/O', description: ckptDerivedDescription('Average total I/O time (write + sync) per checkpoint; the combined cost of a checkpoint flush cycle.', '(write_time + sync_time) / (num_requested + num_timed)'), kind: 'duration_ms', title: 'Avg total I/O time per checkpoint over time', category: 'derived', series: avgTotalIoSeries }, CKPT_GROUP.pressure);

	const buffersPerCkptSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers / checkpoint', description: ckptDerivedDescription('Average dirty buffers flushed per checkpoint; rising values mean checkpoints are growing larger, increasing their I/O impact and duration.', 'buffers_written / (num_requested + num_timed)'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_written'), totalCheckpointsAt(r, i)) }
	]);
	pushCkpt({ key: 'checkpoint_buffers_per_ckpt', label: 'Buffers / Ckpt', description: ckptDerivedDescription('Average dirty buffers flushed per checkpoint; rising values mean checkpoints are growing larger, increasing their I/O impact and duration.', 'buffers_written / (num_requested + num_timed)'), kind: 'count', title: 'Buffers written per checkpoint over time', category: 'derived', series: buffersPerCkptSeries }, CKPT_GROUP.pressure);

	const writeTimePerBufferSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'write time / buffer (ms)', description: ckptDerivedDescription('Write time per buffer flushed during checkpoints; high values suggest storage throughput limits under checkpoint load regardless of checkpoint size.', 'write_time / buffers_written'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'write_time'), deltaAt(r, i, 'buffers_written')) }
	]);
	pushCkpt({ key: 'checkpoint_write_time_per_buffer', label: 'Write Time / Buffer', description: ckptDerivedDescription('Write time per buffer flushed during checkpoints; high values suggest storage throughput limits under checkpoint load regardless of checkpoint size.', 'write_time / buffers_written'), kind: 'duration_ms', title: 'Checkpoint write time per buffer over time', category: 'derived', series: writeTimePerBufferSeries }, CKPT_GROUP.writeIo);

	const syncWriteRatioSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'sync / write time ratio', description: ckptDerivedDescription('Sync time relative to write time; a ratio > 1 means flushing to durable storage takes longer than writing — often indicates OS page-cache pressure or slow fsync.', 'sync_time / write_time'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'sync_time'), deltaAt(r, i, 'write_time')) }
	]);
	pushCkpt({ key: 'checkpoint_sync_write_ratio', label: 'Sync/Write Ratio', description: ckptDerivedDescription('Sync time relative to write time; a ratio > 1 means flushing to durable storage takes longer than writing — often indicates OS page-cache pressure or slow fsync.', 'sync_time / write_time'), kind: 'count', title: 'Sync vs write time ratio over time', category: 'derived', series: syncWriteRatioSeries }, CKPT_GROUP.sync);

	const restartpointRatioSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'restartpoint share', description: ckptDerivedDescription('Share of checkpoint-like flush events that were restartpoints rather than checkpoints; non-zero values indicate the server is operating as a standby.', 'restartpoints_done / (checkpoints + restartpoints_done)'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'restartpoints_done'), sum([totalCheckpointsAt(r, i), deltaAt(r, i, 'restartpoints_done')])) }
	]);
	pushCkpt({ key: 'restartpoint_ratio', label: 'Restartpoint Share', description: ckptDerivedDescription('Share of checkpoint-like flush events that were restartpoints rather than checkpoints; non-zero values indicate the server is operating as a standby.', 'restartpoints_done / (checkpoints + restartpoints_done)'), kind: 'percent', title: 'Restartpoints as share of total flush events', category: 'derived', series: restartpointRatioSeries }, CKPT_GROUP.frequency);

	// Workload Shape (cross-database)
	const checkpointsPerKTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'checkpoints / 1k tx', description: ckptDerivedDescription('Checkpoints per 1000 transactions; normalises checkpoint frequency by workload intensity for cross-run comparison independent of run duration.', '(total_checkpoints / transactions) × 1000'), seriesValueAt: (r, i) => {
			const value = safeRatio(totalCheckpointsAt(r, i), transactionsAt(r, i));
			return value === null ? null : value * 1000;
		} }
	]);
	pushCkpt({ key: 'checkpoints_per_k_tx', label: 'Checkpoints / 1k Tx', description: ckptDerivedDescription('Checkpoints per 1000 transactions; normalises checkpoint frequency by workload intensity for cross-run comparison independent of run duration.', '(total_checkpoints / transactions) × 1000'), kind: 'count', title: 'Checkpoints per 1000 transactions over time', category: 'derived', series: checkpointsPerKTxSeries }, CKPT_GROUP.workload);

	const buffersWrittenPerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'buffers written / tx', description: ckptDerivedDescription('Checkpoint buffer writes per transaction; measures checkpoint write volume per unit of work — complements BGWriter buffers clean/tx to give a full picture of background write pressure.', 'buffers_written / transactions'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'buffers_written'), transactionsAt(r, i)) }
	]);
	pushCkpt({ key: 'checkpoint_buffers_per_tx', label: 'Buffers Written / Tx', description: ckptDerivedDescription('Checkpoint buffer writes per transaction; measures checkpoint write volume per unit of work — complements BGWriter buffers clean/tx to give a full picture of background write pressure.', 'buffers_written / transactions'), kind: 'count', title: 'Checkpoint buffers written per transaction over time', category: 'derived', series: buffersWrittenPerTxSeries }, CKPT_GROUP.workload);

	const writeTimePerTxSeries = buildDerivedSeries(rows, runStartMs, [
		{ label: 'write time (ms) / tx', description: ckptDerivedDescription('Checkpoint write time per transaction; the per-unit-of-work I/O cost of checkpoints — a design that generates more dirty pages per transaction will have a higher value here.', 'write_time / transactions'), seriesValueAt: (r, i) => safeRatio(deltaAt(r, i, 'write_time'), transactionsAt(r, i)) }
	]);
	pushCkpt({ key: 'checkpoint_write_time_per_tx', label: 'Write Time / Tx', description: ckptDerivedDescription('Checkpoint write time per transaction; the per-unit-of-work I/O cost of checkpoints — a design that generates more dirty pages per transaction will have a higher value here.', 'write_time / transactions'), kind: 'duration_ms', title: 'Checkpoint write time per transaction over time', category: 'derived', series: writeTimePerTxSeries }, CKPT_GROUP.workload);

	return {
		key: 'checkpointer',
		label: 'Checkpointer',
		status: 'ok',
		summary: [],
		chartTitle: ckptChartMetrics[0]?.title ?? 'Checkpoint activity over time',
		chartSeries: ckptChartMetrics[0]?.series ?? [],
		chartMetrics: ckptChartMetrics,
		defaultChartMetricKey: 'checkpoint_counts',
		tableTitle: 'Checkpointer metrics',
		tableColumns: [
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'value', label: 'Value' }
		],
		tableRows: makeMetricRows([
			{ metric: 'Requested checkpoints', value: numRequested, kind: 'count' },
			{ metric: 'Timed checkpoints', value: numTimed, kind: 'count' },
			{ metric: 'Checkpoint pressure', value: checkpointPressure, kind: 'percent' },
			{ metric: 'Timed restartpoints', value: delta(rows, 'restartpoints_timed'), kind: 'count' },
			{ metric: 'Requested restartpoints', value: delta(rows, 'restartpoints_req'), kind: 'count' },
			{ metric: 'Restartpoints done', value: restartpointsDone, kind: 'count' },
			{ metric: 'Restartpoint share', value: restartpointRatio, kind: 'percent' },
			{ metric: 'Write time (ms)', value: writeTime, kind: 'duration_ms' },
			{ metric: 'Sync time (ms)', value: syncTime, kind: 'duration_ms' },
			{ metric: 'Sync/write ratio', value: syncWriteRatio, kind: 'count' },
			{ metric: 'Buffers written', value: buffersWritten, kind: 'count' },
			{ metric: 'SLRU written', value: slruWritten, kind: 'count' },
			{ metric: 'Avg write time / ckpt (ms)', value: avgWriteTimePerCkpt, kind: 'duration_ms' },
			{ metric: 'Avg sync time / ckpt (ms)', value: avgSyncTimePerCkpt, kind: 'duration_ms' },
			{ metric: 'Avg total I/O / ckpt (ms)', value: avgTotalIoPerCkpt, kind: 'duration_ms' },
			{ metric: 'Buffers / checkpoint', value: buffersPerCkpt, kind: 'count' },
			{ metric: 'Write time / buffer (ms)', value: writeTimePerBuffer, kind: 'duration_ms' },
			{ metric: 'Checkpoints / 1k tx', value: checkpointsPerKTx, kind: 'count' },
			{ metric: 'Buffers written / tx', value: buffersWrittenPerTx, kind: 'count' },
			{ metric: 'Write time / tx (ms)', value: writeTimePerTx, kind: 'duration_ms' },
			{ metric: 'Stats reset', value: latestText(rows, 'stats_reset'), kind: 'text' }
		]),
		tableSnapshots: buildMetricTableSnapshots(rows, runStartMs, (snapshotRows, index) =>
			makeMetricRows([
				{ metric: 'Requested checkpoints', value: deltaAt(snapshotRows, index, 'num_requested'), kind: 'count' },
				{ metric: 'Timed checkpoints', value: deltaAt(snapshotRows, index, 'num_timed'), kind: 'count' },
				{ metric: 'Checkpoint pressure', value: ratioAt(snapshotRows, index, 'num_requested', ['num_requested', 'num_timed']), kind: 'percent' },
				{ metric: 'Timed restartpoints', value: deltaAt(snapshotRows, index, 'restartpoints_timed'), kind: 'count' },
				{ metric: 'Requested restartpoints', value: deltaAt(snapshotRows, index, 'restartpoints_req'), kind: 'count' },
				{ metric: 'Restartpoints done', value: deltaAt(snapshotRows, index, 'restartpoints_done'), kind: 'count' },
				{ metric: 'Restartpoint share', value: safeRatio(deltaAt(snapshotRows, index, 'restartpoints_done'), sum([totalCheckpointsAt(snapshotRows, index), deltaAt(snapshotRows, index, 'restartpoints_done')])), kind: 'percent' },
				{ metric: 'Write time (ms)', value: deltaAt(snapshotRows, index, 'write_time'), kind: 'duration_ms' },
				{ metric: 'Sync time (ms)', value: deltaAt(snapshotRows, index, 'sync_time'), kind: 'duration_ms' },
				{ metric: 'Sync/write ratio', value: safeRatio(deltaAt(snapshotRows, index, 'sync_time'), deltaAt(snapshotRows, index, 'write_time')), kind: 'count' },
				{ metric: 'Buffers written', value: deltaAt(snapshotRows, index, 'buffers_written'), kind: 'count' },
				{ metric: 'SLRU written', value: deltaAt(snapshotRows, index, 'slru_written'), kind: 'count' },
				{ metric: 'Avg write time / ckpt (ms)', value: safeRatio(deltaAt(snapshotRows, index, 'write_time'), totalCheckpointsAt(snapshotRows, index)), kind: 'duration_ms' },
				{ metric: 'Avg sync time / ckpt (ms)', value: safeRatio(deltaAt(snapshotRows, index, 'sync_time'), totalCheckpointsAt(snapshotRows, index)), kind: 'duration_ms' },
				{ metric: 'Avg total I/O / ckpt (ms)', value: safeRatio(sum([deltaAt(snapshotRows, index, 'write_time'), deltaAt(snapshotRows, index, 'sync_time')]), totalCheckpointsAt(snapshotRows, index)), kind: 'duration_ms' },
				{ metric: 'Buffers / checkpoint', value: safeRatio(deltaAt(snapshotRows, index, 'buffers_written'), totalCheckpointsAt(snapshotRows, index)), kind: 'count' },
				{ metric: 'Write time / buffer (ms)', value: safeRatio(deltaAt(snapshotRows, index, 'write_time'), deltaAt(snapshotRows, index, 'buffers_written')), kind: 'duration_ms' },
				{ metric: 'Checkpoints / 1k tx', value: (() => { const v = safeRatio(totalCheckpointsAt(snapshotRows, index), transactionsAt(snapshotRows, index)); return v === null ? null : v * 1000; })(), kind: 'count' },
				{ metric: 'Buffers written / tx', value: safeRatio(deltaAt(snapshotRows, index, 'buffers_written'), transactionsAt(snapshotRows, index)), kind: 'count' },
				{ metric: 'Write time / tx (ms)', value: safeRatio(deltaAt(snapshotRows, index, 'write_time'), transactionsAt(snapshotRows, index)), kind: 'duration_ms' },
				{ metric: 'Stats reset', value: snapshotRows[index].stats_reset == null ? null : String(snapshotRows[index].stats_reset), kind: 'text' }
			])
		)
	};
}

// Fetch rows from a host_snap_* table filtered by phase time ranges.
// host_snap_* tables have no _phase column, so phases are resolved via timestamps.
function fetchHostRows(
	db: Database.Database,
	tableName: string,
	runId: number,
	phases: TelemetryPhase[] = ALL_PHASES,
	benchStartedAt: string | null = null,
	postStartedAt: string | null = null
): Record<string, unknown>[] {
	if (!tableExists(db, tableName)) return [];
	try {
		const needsFilter = phases.length < ALL_PHASES.length && benchStartedAt !== null;
		if (!needsFilter) {
			return db.prepare(`SELECT * FROM ${tableName} WHERE _run_id = ? ORDER BY _collected_at`).all(runId) as Record<string, unknown>[];
		}
		const rangeClauses: string[] = [];
		const rangeParams: unknown[] = [];
		if (phases.includes('pre')) {
			rangeClauses.push('_collected_at < ?');
			rangeParams.push(benchStartedAt);
		}
		if (phases.includes('bench')) {
			if (postStartedAt !== null) {
				rangeClauses.push('(_collected_at >= ? AND _collected_at < ?)');
				rangeParams.push(benchStartedAt, postStartedAt);
			} else {
				rangeClauses.push('_collected_at >= ?');
				rangeParams.push(benchStartedAt);
			}
		}
		if (phases.includes('post') && postStartedAt !== null) {
			rangeClauses.push('_collected_at >= ?');
			rangeParams.push(postStartedAt);
		}
		if (rangeClauses.length === 0) return [];
		const sql = `SELECT * FROM ${tableName} WHERE _run_id = ? AND (${rangeClauses.join(' OR ')}) ORDER BY _collected_at`;
		return db.prepare(sql).all(runId, ...rangeParams) as Record<string, unknown>[];
	} catch {
		return [];
	}
}

// Build a TelemetryChartMetric from instantaneous (already per-unit) rows.
function buildInstantGroup(
	key: string, label: string, title: string,
	rows: Record<string, unknown>[],
	cols: string[],
	kind: TelemetryValueKind,
	runStartMs: number,
	scale = 1,
	colLabels?: Record<string, string>,
	colDescriptions?: Record<string, string>
): TelemetryChartMetric | null {
	const series: TelemetrySeries[] = [];
	let colorIdx = 0;
	for (const col of cols) {
		const points: TelemetrySeriesPoint[] = [];
		for (const row of rows) {
			const t = toMs(row._collected_at as string | null);
			if (t === null) continue;
			const v = Number(row[col]);
			if (!Number.isFinite(v)) continue;
			points.push({ t: t - runStartMs, v: v * scale });
		}
		if (points.length > 0) {
			series.push({
				label: colLabels?.[col] ?? col,
				description: colDescriptions?.[col],
				color: COLORS[colorIdx++ % COLORS.length],
				points
			});
		}
	}
	if (series.length === 0) return null;
	return { key, label, kind, title, series };
}

// Build a TelemetryChartMetric from cumulative counter rows — computes per-second delta rates.
function buildRateGroup(
	key: string, label: string, title: string,
	rows: Record<string, unknown>[],
	cols: string[],
	kind: TelemetryValueKind,
	runStartMs: number,
	scale = 1,
	colLabels?: Record<string, string>,
	colDescriptions?: Record<string, string>
): TelemetryChartMetric | null {
	const series: TelemetrySeries[] = [];
	const rawSeries: TelemetrySeries[] = [];
	let colorIdx = 0;
	for (const col of cols) {
		const points: TelemetrySeriesPoint[] = [];
		const rawPoints: TelemetrySeriesPoint[] = [];
		const color = COLORS[colorIdx % COLORS.length];
		let rawBaseline: number | null = null;
		for (const row of rows) {
			const t = toMs(row._collected_at as string | null);
			if (t === null) continue;
			const value = Number(row[col]);
			if (!Number.isFinite(value)) continue;
			if (rawBaseline === null) rawBaseline = value;
			if (value < rawBaseline) continue;
			rawPoints.push({ t: t - runStartMs, v: (value - rawBaseline) * scale });
		}
		for (let i = 1; i < rows.length; i++) {
			const t1 = toMs(rows[i]._collected_at as string | null);
			const t0 = toMs(rows[i - 1]._collected_at as string | null);
			if (t1 === null || t0 === null) continue;
			const dt = (t1 - t0) / 1000;
			if (dt <= 0) continue;
			const cur = Number(rows[i][col]);
			const prev = Number(rows[i - 1][col]);
			if (!Number.isFinite(cur) || !Number.isFinite(prev) || cur < prev) continue;
			points.push({ t: t1 - runStartMs, v: ((cur - prev) / dt) * scale });
		}
		if (points.length > 0) {
			series.push({
				label: colLabels?.[col] ?? col,
				description: colDescriptions?.[col],
				color,
				points
			});
			if (rawPoints.length > 0) {
				rawSeries.push({
					label: rawCounterLabel(colLabels?.[col] ?? col),
					description: rawCounterDescription(colDescriptions?.[col], colLabels?.[col] ?? col),
					color,
					points: rawPoints
				});
			}
			colorIdx++;
		}
	}
	if (series.length === 0) return null;
	return { key, label, kind, title, series, rawSeries };
}

function rawCounterLabel(label: string): string {
	return label
		.replace(/KB\/s/g, 'KB')
		.replace(/pkts\/s/g, 'pkts')
		.replace(/sectors\/s/g, 'sectors')
		.replace(/ms\/s/g, 'ms')
		.replace(/ns\/s/g, 'ns')
		.replace(/\/s\b/g, '')
		.trim();
}

function rawCounterDescription(description: string | undefined, label: string): string {
	const base = description
		? description
		.replace(/per second/gi, 'as a raw counter')
		.replace(/rate\/s/gi, 'raw counter')
			.replace(/→ converted to raw counter/gi, 'raw counter')
		: label;
	return `${base}; normalized to zero at the first sample`;
}

function buildHostDerivedRateGroup(
	key: string,
	label: string,
	title: string,
	rows: Record<string, unknown>[],
	seriesDefs: Array<{
		label: string;
		description?: string;
		valueFn: (cur: Record<string, unknown>, prev: Record<string, unknown>, dt: number) => number | null;
	}>,
	kind: TelemetryValueKind,
	runStartMs: number
): TelemetryChartMetric | null {
	const series = seriesDefs
		.map((def, index): TelemetrySeries | null => {
			const points: TelemetrySeriesPoint[] = [];
			for (let i = 1; i < rows.length; i++) {
				const t1 = toMs(rows[i]._collected_at as string | null);
				const t0 = toMs(rows[i - 1]._collected_at as string | null);
				if (t1 === null || t0 === null) continue;
				const dt = (t1 - t0) / 1000;
				if (dt <= 0) continue;
				const value = def.valueFn(rows[i], rows[i - 1], dt);
				if (value === null || !Number.isFinite(value)) continue;
				points.push({ t: t1 - runStartMs, v: value });
			}
			if (points.length === 0) return null;
			return { label: def.label, description: def.description, color: COLORS[index % COLORS.length], points };
		})
		.filter((item): item is TelemetrySeries => item !== null);
	if (series.length === 0) return null;
	return { key, label, kind, title, series };
}

function withChartGroup(metric: TelemetryChartMetric | null, group: string, entity?: string): TelemetryChartMetric | null {
	if (!metric) return null;
	return { ...metric, group, entity };
}

function pushChartMetric(metrics: TelemetryChartMetric[], metric: TelemetryChartMetric | null) {
	if (metric) metrics.push(metric);
}

function buildHostDerivedInstantGroup(
	key: string,
	label: string,
	title: string,
	rows: Record<string, unknown>[],
	seriesDefs: Array<{
		label: string;
		description?: string;
		valueFn: (row: Record<string, unknown>) => number | null;
	}>,
	kind: TelemetryValueKind,
	runStartMs: number
): TelemetryChartMetric | null {
	const series = seriesDefs
		.map((def, index): TelemetrySeries | null => {
			const points = rows
				.map((row) => {
					const t = toMs(row._collected_at as string | null);
					if (t === null) return null;
					const value = def.valueFn(row);
					if (value === null || !Number.isFinite(value)) return null;
					return { t: t - runStartMs, v: value };
				})
				.filter((point): point is TelemetrySeriesPoint => point !== null);
			if (points.length === 0) return null;
			return {
				label: def.label,
				description: def.description,
				color: COLORS[index % COLORS.length],
				points
			};
		})
		.filter((item): item is TelemetrySeries => item !== null);
	if (series.length === 0) return null;
	return { key, label, title, kind, series };
}

// Human-readable labels for raw /proc column names.
const HOST_COL_LABELS: Record<string, string> = {
	// loadavg
	load1: '1 min', load5: '5 min', load15: '15 min', running_threads: 'Running threads',
	// meminfo
	mem_total: 'Total', mem_available: 'Available', mem_free: 'Free',
	buffers: 'Buffers', cached: 'Page cache', swap_cached: 'Swap cache',
	active: 'Active', inactive: 'Inactive', active_anon: 'Active anon',
	inactive_anon: 'Inactive anon', active_file: 'Active file',
	inactive_file: 'Inactive file', slab: 'Slab', sreclaimable: 'Slab reclaimable',
	sunreclaim: 'Slab unreclaimable', kreclaimable: 'Kernel reclaimable',
	page_tables: 'Page tables', kernel_stack: 'Kernel stack',
	dirty: 'Dirty', writeback: 'Writeback', swap_total: 'Swap total', swap_free: 'Swap free',
	committed_as: 'Committed', commit_limit: 'Commit limit',
	anon_pages: 'Anonymous pages', mapped: 'Mapped', shmem: 'Shared mem',
	hugepages_total: 'Huge pages total', hugepages_free: 'Huge pages free',
	anon_huge_pages: 'Anon huge pages', file_huge_pages: 'File huge pages',
	zswap: 'Zswap', zswapped: 'Zswapped',
	// /proc/stat
	cpu_user: 'User', cpu_nice: 'Nice', cpu_system: 'System', cpu_iowait: 'IO Wait',
	cpu_steal: 'Stolen', cpu_irq: 'IRQ', cpu_softirq: 'Soft IRQ',
	ctxt: 'Ctx switches/s', processes: 'Forks/s',
	procs_running: 'Runnable', procs_blocked: 'Blocked',
	// /proc/vmstat
	pgpgin: 'Pages in/s', pgpgout: 'Pages out/s',
	pgfault: 'Minor faults/s', pgmajfault: 'Major faults/s',
	pswpin: 'Swap in/s', pswpout: 'Swap out/s',
	nr_dirty: 'Dirty pages', nr_writeback: 'Writeback pages', nr_shmem: 'Shared pages',
	pgsteal_kswapd: 'kswapd reclaim/s', pgsteal_direct: 'Direct reclaim/s',
	pgscan_kswapd: 'kswapd scanned/s', pgscan_direct: 'Direct scanned/s',
	allocstall_normal: 'Normal alloc stalls/s', allocstall_movable: 'Movable alloc stalls/s',
	allocstall_dma: 'DMA alloc stalls/s', allocstall_dma32: 'DMA32 alloc stalls/s',
	workingset_refault_anon: 'Anon refaults/s', workingset_refault_file: 'File refaults/s',
	workingset_activate_anon: 'Anon activations/s', workingset_activate_file: 'File activations/s',
	oom_kill: 'OOM kills/s',
	thp_fault_alloc: 'THP fault alloc/s', thp_fault_fallback: 'THP fault fallback/s',
	thp_collapse_alloc: 'THP collapse alloc/s', thp_collapse_alloc_failed: 'THP collapse failed/s',
	thp_split_page: 'THP page splits/s', thp_swpout: 'THP swapout/s',
	// diskstats
	rd_ios: 'Reads/s', wr_ios: 'Writes/s',
	rd_merges: 'Read merges/s', wr_merges: 'Write merges/s',
	rd_sectors: 'Read sectors/s', wr_sectors: 'Write sectors/s',
	in_flight: 'In-flight I/Os', rd_ticks: 'Read ms/s', wr_ticks: 'Write ms/s', io_ticks: 'Total ms/s',
	time_in_queue: 'Weighted queue ms/s',
	dc_ios: 'Discards/s', dc_sectors: 'Discard sectors/s', dc_ticks: 'Discard ms/s',
	fl_ios: 'Flushes/s', fl_ticks: 'Flush ms/s',
	// netdev
	rx_bytes: 'Recv KB/s', tx_bytes: 'Send KB/s',
	rx_packets: 'Recv pkts/s', tx_packets: 'Send pkts/s',
	rx_errs: 'Recv errors/s', tx_errs: 'Send errors/s',
	rx_drop: 'Recv drops/s', tx_drop: 'Send drops/s',
	rx_fifo: 'Recv FIFO/s', rx_frame: 'Recv frame/s', rx_multicast: 'Recv multicast/s',
	tx_fifo: 'Send FIFO/s', tx_colls: 'Collisions/s', tx_carrier: 'Carrier errors/s',
	// PSI
	cpu_some_avg10: 'CPU some', memory_some_avg10: 'Mem some', io_some_avg10: 'IO some',
	memory_full_avg10: 'Mem full', io_full_avg10: 'IO full',
	cpu_some_avg60: 'CPU some 60s', memory_some_avg60: 'Mem some 60s', io_some_avg60: 'IO some 60s',
	cpu_some_avg300: 'CPU some 300s', memory_some_avg300: 'Mem some 300s', io_some_avg300: 'IO some 300s',
	cpu_some_total: 'CPU stall total', memory_some_total: 'Mem stall total', io_some_total: 'IO stall total',
	cpu_full_total: 'CPU full total', memory_full_total: 'Mem full total', io_full_total: 'IO full total',
	// schedstat
	run_time_ns: 'Run time ns/s', wait_time_ns: 'Wait time ns/s',
	timeslices: 'Timeslices/s',
	// file table
	allocated: 'Allocated files', max: 'File max',
	// per-pid
	utime: 'User jiffies/s', stime: 'Sys jiffies/s',
	minflt: 'Minor faults/s', majflt: 'Major faults/s',
	num_threads: 'Threads',
	vsize: 'Virtual bytes', rss: 'RSS pages',
	size: 'Total pages', resident: 'Resident pages', shared: 'Shared pages',
	text: 'Text pages', lib: 'Library pages', data: 'Data pages', dt: 'Dirty pages',
	rchar: 'Read chars/s', wchar: 'Write chars/s',
	syscr: 'Read syscalls/s', syscw: 'Write syscalls/s',
	read_bytes: 'Read KB/s', write_bytes: 'Write KB/s',
	cancelled_write_bytes: 'Cancelled write KB/s',
	vm_peak_kb: 'Peak virtual', vm_size_kb: 'Virtual size', vm_rss_kb: 'RSS',
	rss_anon_kb: 'Anonymous RSS', rss_file_kb: 'File RSS', rss_shmem_kb: 'Shared RSS',
	vm_swap_kb: 'Swap',
	threads: 'Threads', fd_size: 'FD table size', fd_count: 'Open FDs',
	vol_ctxt_sw: 'Voluntary ctx/s', nvol_ctxt_sw: 'Involuntary ctx/s',
};

// One-line descriptions shown on hover in chart legend and tooltip.
const HOST_COL_DESCS: Record<string, string> = {
	// loadavg
	load1: '1-minute exponential moving average of runnable + uninterruptible tasks',
	load5: '5-minute load average',
	load15: '15-minute load average',
	running_threads: 'Threads currently running or waiting to run / total threads',
	// meminfo
	mem_available: 'Estimated memory available for new processes without swapping',
	mem_free: 'Completely unused memory (excludes reclaimable cache/buffers)',
	cached: 'Page cache — reclaimable under memory pressure',
	dirty: 'Modified pages in RAM not yet written to disk',
	writeback: 'Pages being actively written back to disk right now',
	swap_free: 'Free swap space remaining',
	committed_as: 'Total virtual memory committed to all processes',
	commit_limit: 'Maximum committable memory based on overcommit ratio',
	anon_pages: 'Anonymous pages — heap, stack, not backed by files',
	mapped: 'Memory mapped into process address spaces via mmap',
	shmem: 'Shared memory and tmpfs allocations',
	// /proc/stat
	cpu_user: 'Cumulative CPU jiffies in user mode → converted to rate/s',
	cpu_system: 'Cumulative CPU jiffies in kernel mode → rate/s',
	cpu_iowait: 'Cumulative CPU jiffies waiting for I/O → rate/s',
	cpu_steal: 'Cumulative CPU jiffies stolen by hypervisor → rate/s',
	cpu_irq: 'Cumulative CPU jiffies servicing hardware interrupts → rate/s',
	cpu_softirq: 'Cumulative CPU jiffies servicing software interrupts → rate/s',
	ctxt: 'Context switches per second (from /proc/stat)',
	processes: 'New processes forked per second',
	procs_running: 'Processes currently in a runnable state',
	procs_blocked: 'Processes blocked waiting for I/O',
	// /proc/vmstat
	pgpgin: 'Pages read from disk into page cache per second',
	pgpgout: 'Pages written from page cache to disk per second',
	pgfault: 'Minor page faults/s — page present in RAM but remapped',
	pgmajfault: 'Major page faults/s — page must be fetched from disk',
	pswpin: 'Pages swapped in from swap device per second',
	pswpout: 'Pages swapped out to swap device per second',
	nr_dirty: 'Dirty pages in page cache awaiting writeback',
	nr_writeback: 'Pages currently being written back to disk',
	nr_shmem: 'Pages in shared memory / tmpfs',
	pgsteal_kswapd: 'Pages reclaimed by kswapd (background) per second',
	pgsteal_direct: 'Pages reclaimed by allocator directly (synchronous) per second',
	// diskstats
	rd_ios: 'Completed read I/O operations per second',
	wr_ios: 'Completed write I/O operations per second',
	rd_sectors: '512-byte sectors read per second',
	wr_sectors: '512-byte sectors written per second',
	in_flight: 'I/O requests currently queued to the device',
	rd_ticks: 'Milliseconds spent in read I/O queue per second',
	wr_ticks: 'Milliseconds spent in write I/O queue per second',
	io_ticks: 'Milliseconds the device was busy per second (utilization proxy)',
	// netdev
	rx_bytes: 'Kilobytes received per second',
	tx_bytes: 'Kilobytes transmitted per second',
	rx_packets: 'Packets received per second',
	tx_packets: 'Packets transmitted per second',
	rx_errs: 'Receive errors per second',
	tx_errs: 'Transmit errors per second',
	rx_drop: 'Received packets dropped per second',
	tx_drop: 'Transmitted packets dropped per second',
	// PSI
	cpu_some_avg10: '% of time ≥1 task stalled on CPU (10s rolling avg)',
	memory_some_avg10: '% of time ≥1 task stalled on memory (10s rolling avg)',
	io_some_avg10: '% of time ≥1 task stalled on I/O (10s rolling avg)',
	memory_full_avg10: '% of time ALL tasks stalled on memory (10s rolling avg)',
	io_full_avg10: '% of time ALL tasks stalled on I/O (10s rolling avg)',
	// schedstat
	run_time_ns: 'Nanoseconds the CPU spent running tasks per second',
	wait_time_ns: 'Nanoseconds tasks spent waiting in the run queue per second',
	// per-pid
	utime: 'CPU jiffies in user mode per second',
	stime: 'CPU jiffies in kernel mode (syscalls) per second',
	minflt: 'Minor page faults per second — pages already resident or mapped without disk I/O',
	majflt: 'Major page faults per second — pages that required disk I/O',
	num_threads: 'Kernel thread count reported by /proc/pid/stat',
	vsize: 'Virtual memory size in bytes from /proc/pid/stat',
	rss: 'Resident set size in pages from /proc/pid/stat',
	size: 'Total program size in pages from /proc/pid/statm',
	resident: 'Resident set size in pages (physical memory in use)',
	text: 'Text/code size in pages',
	lib: 'Shared library pages, retained for kernel compatibility',
	data: 'Data + stack size in pages',
	dt: 'Dirty pages, retained for kernel compatibility',
	shared: 'Shared memory pages mapped by this process',
	rchar: 'Bytes returned by read-like syscalls per second, including cache hits',
	wchar: 'Bytes passed to write-like syscalls per second, before cancellation',
	syscr: 'Read-like system calls per second',
	syscw: 'Write-like system calls per second',
	read_bytes: 'Kilobytes read from storage per second (/proc/pid/io)',
	write_bytes: 'Kilobytes written to storage per second (/proc/pid/io)',
	cancelled_write_bytes: 'Kilobytes of previously accounted writes cancelled per second',
	vm_peak_kb: 'Peak virtual memory size',
	vm_size_kb: 'Current virtual memory size',
	vm_rss_kb: 'Resident set size in physical memory',
	rss_anon_kb: 'Anonymous resident memory such as heap and stack',
	rss_file_kb: 'File-backed resident memory',
	rss_shmem_kb: 'Shared memory resident set',
	vm_swap_kb: 'Swapped-out virtual memory',
	threads: 'Thread count from /proc/pid/status',
	fd_size: 'Allocated file descriptor table slots',
	fd_count: 'Open file descriptors counted from /proc/pid/fd',
	timeslices: 'Scheduler timeslices per second',
	vol_ctxt_sw: 'Voluntary context switches per second',
	nvol_ctxt_sw: 'Involuntary context switches per second',
};

function buildHostSystemSection(db: Database.Database, runId: number, runStartMs: number, selectedPhases: TelemetryPhase[], benchStartedAt: string | null, postStartedAt: string | null): TelemetrySection {
	const noData: TelemetrySection = {
		key: 'host_system',
		label: 'System',
		status: 'no_data',
		reason: 'No host OS metrics collected. Requires SSH enabled on the server configuration.',
		summary: [], chartTitle: '', chartSeries: [],
		tableTitle: '', tableColumns: [], tableRows: [], tableSnapshots: []
	};

	const fetchH = (t: string) => fetchHostRows(db, t, runId, selectedPhases, benchStartedAt, postStartedAt);
	const loadavgRows    = fetchH('host_snap_proc_loadavg');
	const meminfoRows    = fetchH('host_snap_proc_meminfo');
	const statRows       = fetchH('host_snap_proc_stat');
	const procVmstatRows = fetchH('host_snap_proc_vmstat');
	const diskstatsRows  = fetchH('host_snap_proc_diskstats');
	const netdevRows     = fetchH('host_snap_proc_netdev');
	const schedstatRows  = fetchH('host_snap_proc_schedstat');
	const psiRows        = fetchH('host_snap_proc_psi');
	const fileNrRows     = fetchH('host_snap_proc_sys_fs_file_nr');
	const hostConfigJson = tableHasColumn(db, 'benchmark_runs', 'host_config')
		? (db.prepare(`SELECT host_config FROM benchmark_runs WHERE id = ?`).get(runId) as { host_config?: string | null } | undefined)?.host_config
		: null;
	let hostConfig: Record<string, unknown> = {};
	if (hostConfigJson) {
		try {
			const parsed = JSON.parse(hostConfigJson);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hostConfig = parsed as Record<string, unknown>;
		} catch {
			hostConfig = {};
		}
	}

	const hasData = loadavgRows.length > 0 || meminfoRows.length > 0
		|| statRows.length > 0 || diskstatsRows.length > 0 || fileNrRows.length > 0
		|| Object.keys(hostConfig).length > 0;
	if (!hasData) return noData;

	const L = HOST_COL_LABELS;
	const D = HOST_COL_DESCS;
	const chartMetrics: TelemetryChartMetric[] = [];

	// Load average
	if (loadavgRows.length > 0) {
		const g = buildInstantGroup('load_avg', 'Load Average', 'Load Average', loadavgRows,
			['load1', 'load5', 'load15'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'CPU'));
		const g2 = buildHostDerivedInstantGroup('threads_total', 'Thread Count', 'Host Threads', loadavgRows, [
			{ label: 'Total threads', description: 'Total scheduler entities from /proc/loadavg', valueFn: (row) => toNumber(row.total_threads) },
			{ label: 'Running threads', description: D.running_threads, valueFn: (row) => toNumber(row.running_threads) }
		], 'count', runStartMs);
		pushChartMetric(chartMetrics, withChartGroup(g2, 'CPU'));
	}

	// Memory — instantaneous kB values
	if (meminfoRows.length > 0) {
		const g = buildInstantGroup('memory', 'Memory', 'Memory', meminfoRows,
			['mem_available', 'cached', 'dirty', 'writeback', 'swap_free', 'mem_free'], 'bytes', runStartMs, 1024, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'Memory'));
		const used = buildHostDerivedInstantGroup('mem_used', 'Memory Used', 'Memory Used / Available', meminfoRows, [
			{
				label: 'Used',
				description: 'mem_total - mem_available from /proc/meminfo',
				valueFn: (row) => {
					const total = toNumber(row.mem_total);
					const available = toNumber(row.mem_available);
					return total !== null && available !== null ? (total - available) * 1024 : null;
				}
			},
			{ label: 'Available', description: D.mem_available, valueFn: (row) => toNumber(row.mem_available) === null ? null : Number(row.mem_available) * 1024 }
		], 'bytes', runStartMs);
		pushChartMetric(chartMetrics, withChartGroup(used, 'Memory'));
		const composition = buildInstantGroup('mem_composition', 'Memory Areas', 'Memory Composition', meminfoRows,
			['anon_pages', 'cached', 'buffers', 'shmem', 'slab', 'sreclaimable', 'sunreclaim'],
			'bytes', runStartMs, 1024, L, D);
		pushChartMetric(chartMetrics, withChartGroup(composition, 'Memory'));
		const activity = buildInstantGroup('mem_active_inactive', 'Active/Inactive', 'Active and Inactive Memory', meminfoRows,
			['active_anon', 'inactive_anon', 'active_file', 'inactive_file'],
			'bytes', runStartMs, 1024, L, D);
		pushChartMetric(chartMetrics, withChartGroup(activity, 'Memory'));
		const kernel = buildInstantGroup('mem_kernel', 'Kernel Memory', 'Kernel Memory', meminfoRows,
			['kreclaimable', 'sreclaimable', 'sunreclaim', 'kernel_stack', 'page_tables'],
			'bytes', runStartMs, 1024, L, D);
		pushChartMetric(chartMetrics, withChartGroup(kernel, 'Memory'));
		const swapSpace = buildHostDerivedInstantGroup('swap_space', 'Swap Space', 'Swap Used / Free', meminfoRows, [
			{
				label: 'Swap used',
				description: 'swap_total - swap_free from /proc/meminfo',
				valueFn: (row) => {
					const total = toNumber(row.swap_total);
					const free = toNumber(row.swap_free);
					return total !== null && free !== null ? (total - free) * 1024 : null;
				}
			},
			{ label: 'Swap free', description: D.swap_free, valueFn: (row) => toNumber(row.swap_free) === null ? null : Number(row.swap_free) * 1024 }
		], 'bytes', runStartMs);
		pushChartMetric(chartMetrics, withChartGroup(swapSpace, 'Memory'));
		const hugePages = buildInstantGroup('huge_pages', 'Huge Pages', 'Huge Page Memory', meminfoRows,
			['anon_huge_pages', 'file_huge_pages', 'hugetlb', 'zswap', 'zswapped'],
			'bytes', runStartMs, 1024, L, D);
		pushChartMetric(chartMetrics, withChartGroup(hugePages, 'Memory'));
		const g2 = buildInstantGroup('mem_commit', 'Mem Commit', 'Committed Memory', meminfoRows,
			['committed_as', 'commit_limit', 'anon_pages', 'mapped', 'shmem'], 'bytes', runStartMs, 1024, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g2, 'Memory'));
	}

	// /proc/stat CPU jiffies → rates
	if (statRows.length > 1) {
		const CPU_TOTAL_COLS = ['cpu_user', 'cpu_nice', 'cpu_system', 'cpu_idle', 'cpu_iowait', 'cpu_irq', 'cpu_softirq', 'cpu_steal', 'cpu_guest', 'cpu_guest_nice'];
		function cpuTotalDelta(cur: Record<string, unknown>, prev: Record<string, unknown>): number {
			return CPU_TOTAL_COLS.reduce((sum, col) => {
				const d = Number(cur[col]) - Number(prev[col]);
				return sum + (Number.isFinite(d) ? d : 0);
			}, 0);
		}
		function cpuPct(cols: string[]): (cur: Record<string, unknown>, prev: Record<string, unknown>) => number | null {
			return (cur, prev) => {
				const total = cpuTotalDelta(cur, prev);
				if (total <= 0) return null;
				const comp = cols.reduce((sum, col) => {
					const d = Number(cur[col]) - Number(prev[col]);
					return sum + (Number.isFinite(d) && d >= 0 ? d : 0);
				}, 0);
				return (comp / total) * 100;
			};
		}
		const cpuPctGroup = buildHostDerivedRateGroup('stat_cpu_pct', 'CPU %', 'CPU Usage % (/proc/stat)', statRows, [
			{ label: 'User %',    description: 'CPU time in user-space processes, normalized across all cores', valueFn: cpuPct(['cpu_user']) },
			{ label: 'Nice %',    description: 'CPU time in user-space processes running at lowered priority (nice > 0)', valueFn: cpuPct(['cpu_nice']) },
			{ label: 'System %',  description: 'CPU time in kernel-space (syscalls, drivers)', valueFn: cpuPct(['cpu_system']) },
			{ label: 'IO Wait %', description: 'CPU time idle while waiting for I/O to complete', valueFn: cpuPct(['cpu_iowait']) },
			{ label: 'Stolen %',  description: 'CPU time stolen by the hypervisor for other VMs (cloud environments)', valueFn: cpuPct(['cpu_steal']) },
			{ label: 'Idle %',    description: 'CPU time truly idle', valueFn: cpuPct(['cpu_idle']) },
		], 'percent', runStartMs);
		pushChartMetric(chartMetrics, withChartGroup(cpuPctGroup, 'CPU'));

		const g = buildRateGroup('stat_cpu', 'CPU Jiffies', 'CPU Jiffies /s (/proc/stat)', statRows,
			['cpu_user', 'cpu_nice', 'cpu_system', 'cpu_iowait', 'cpu_steal', 'cpu_irq', 'cpu_softirq'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'CPU'));
		const g2 = buildRateGroup('stat_ctx', 'Ctx & Interrupts', 'Context Switches, Interrupts & Forks /s', statRows,
			['ctxt', 'intr', 'processes'], 'count', runStartMs, 1,
			{ ctxt: 'Ctx switches/s', intr: 'Interrupts/s', processes: 'Forks/s' },
			{ ctxt: 'CPU context switches per second — high values indicate heavy scheduling pressure or lock contention', intr: 'Hardware interrupts serviced per second — driven by NIC packets, disk I/O completions, and timer ticks', processes: 'New processes (forks) created per second' });
		pushChartMetric(chartMetrics, withChartGroup(g2, 'CPU'));
		const g3 = buildInstantGroup('stat_procs', 'Run Queue', 'Runnable / Blocked Processes', statRows,
			['procs_running', 'procs_blocked'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g3, 'CPU'));
	}

	// /proc/vmstat
	if (procVmstatRows.length > 1) {
		const g = buildRateGroup('page_io', 'Page I/O', 'Page I/O /s', procVmstatRows,
			['pgpgin', 'pgpgout'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'Memory'));
		const g2 = buildRateGroup('page_faults', 'Page Faults', 'Page Faults /s', procVmstatRows,
			['pgfault', 'pgmajfault'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g2, 'Memory'));
		const g3 = buildRateGroup('swap_pages', 'Swap Pages', 'Swap Page Rate /s', procVmstatRows,
			['pswpin', 'pswpout'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g3, 'Memory'));
		const g4 = buildInstantGroup('dirty_pages', 'Dirty Pages', 'Dirty / Writeback Pages', procVmstatRows,
			['nr_dirty', 'nr_writeback', 'nr_shmem'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g4, 'Memory'));
		const g5 = buildRateGroup('page_reclaim', 'Page Reclaim', 'Page Reclaim /s', procVmstatRows,
			['pgsteal_kswapd', 'pgsteal_direct'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g5, 'Kernel Pressure'));
		const reclaimScan = buildRateGroup('page_reclaim_scan', 'Reclaim Scan', 'Page Reclaim Scan /s', procVmstatRows,
			['pgscan_kswapd', 'pgscan_direct', 'pgsteal_kswapd', 'pgsteal_direct'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(reclaimScan, 'Kernel Pressure'));
		const allocStalls = buildRateGroup('alloc_stalls', 'Alloc Stalls', 'Direct Allocation Stalls /s', procVmstatRows,
			['allocstall_normal', 'allocstall_movable', 'allocstall_dma', 'allocstall_dma32'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(allocStalls, 'Kernel Pressure'));
		const workingset = buildRateGroup('workingset', 'Workingset', 'Workingset Refaults / Activations /s', procVmstatRows,
			['workingset_refault_anon', 'workingset_refault_file', 'workingset_activate_anon', 'workingset_activate_file'],
			'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(workingset, 'Kernel Pressure'));
		const thp = buildRateGroup('thp_activity', 'THP Activity', 'Transparent Huge Page Events /s', procVmstatRows,
			['thp_fault_alloc', 'thp_fault_fallback', 'thp_collapse_alloc', 'thp_collapse_alloc_failed', 'thp_split_page', 'thp_swpout'],
			'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(thp, 'Kernel Pressure'));
		const oom = buildRateGroup('oom_kill', 'OOM Kills', 'OOM Kills /s', procVmstatRows,
			['oom_kill'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(oom, 'Kernel Pressure'));
	}

	// Disk I/O — per device
	const diskDevices = [...new Set(diskstatsRows.map(r => r.device as string).filter(Boolean))];
	for (const dev of diskDevices) {
		const devRows = diskstatsRows.filter(r => r.device === dev);
		if (devRows.length < 2) continue;
		const g = buildRateGroup(`disk_${dev}_ops`, 'IOPS', `Disk ${dev} — IOPS`, devRows,
			['rd_ios', 'wr_ios', 'dc_ios', 'fl_ios'], 'count', runStartMs, 1,
			{ rd_ios: 'Reads/s', wr_ios: 'Writes/s', dc_ios: 'Discards/s', fl_ios: 'Flushes/s' },
			{ rd_ios: 'Completed read operations per second', wr_ios: 'Completed write operations per second', dc_ios: 'Completed discard (TRIM) operations per second', fl_ios: 'Completed flush (fsync) operations per second' });
		pushChartMetric(chartMetrics, withChartGroup(g, 'Block Devices', dev));
		const gMerges = buildRateGroup(`disk_${dev}_merges`, 'Merges', `Disk ${dev} — Request Merges /s`, devRows,
			['rd_merges', 'wr_merges', 'dc_merges'], 'count', runStartMs, 1,
			{ rd_merges: 'Read merges/s', wr_merges: 'Write merges/s', dc_merges: 'Discard merges/s' },
			{ rd_merges: 'Read requests merged by the I/O scheduler per second', wr_merges: 'Write requests merged by the I/O scheduler per second', dc_merges: 'Discard requests merged by the I/O scheduler per second' });
		pushChartMetric(chartMetrics, withChartGroup(gMerges, 'Block Devices', dev));
		const g2 = buildRateGroup(`disk_${dev}_bytes`, 'Throughput', `Disk ${dev} — Throughput (KB/s)`, devRows,
			['rd_sectors', 'wr_sectors', 'dc_sectors'], 'bytes', runStartMs, 0.5,
			{ rd_sectors: 'Read KB/s', wr_sectors: 'Write KB/s', dc_sectors: 'Discard KB/s' },
			{ rd_sectors: 'Kilobytes read per second (rd_sectors × 512 bytes)', wr_sectors: 'Kilobytes written per second (wr_sectors × 512 bytes)', dc_sectors: 'Kilobytes discarded (TRIMmed) per second (dc_sectors × 512 bytes)' });
		pushChartMetric(chartMetrics, withChartGroup(g2, 'Block Devices', dev));
		const g3 = buildInstantGroup(`disk_${dev}_queue`, 'Queue', `Disk ${dev} — In-flight I/Os`, devRows,
			['in_flight'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g3, 'Block Devices', dev));
		const g4 = buildHostDerivedRateGroup(`disk_${dev}_busy`, 'Busy %', `Disk ${dev} — Device Busy %`,
			devRows, [
				{
					label: 'Device busy %',
					description: 'Percentage of wall-clock time the device had at least one I/O in flight (io_ticks / elapsed_ms × 100). Capped at 100%.',
					valueFn: (cur, prev, dt) => {
						const dTicks = Number(cur.io_ticks) - Number(prev.io_ticks);
						return Math.min(100, (dTicks / (dt * 1000)) * 100);
					},
				},
			], 'count', runStartMs);
		const g4b_queue = buildHostDerivedRateGroup(`disk_${dev}_occupancy`, 'Queue Depth', `Disk ${dev} — Avg Queue Occupancy`,
			devRows, [
				{
					label: 'Avg concurrent reads',
					description: 'Average number of read I/Os in flight simultaneously (rd_ticks / elapsed_ms). Greater than 1 means parallel reads.',
					valueFn: (cur, prev, dt) => {
						const dTicks = Number(cur.rd_ticks) - Number(prev.rd_ticks);
						return dTicks / (dt * 1000);
					},
				},
				{
					label: 'Avg concurrent writes',
					description: 'Average number of write I/Os in flight simultaneously (wr_ticks / elapsed_ms). Greater than 1 means parallel writes.',
					valueFn: (cur, prev, dt) => {
						const dTicks = Number(cur.wr_ticks) - Number(prev.wr_ticks);
						return dTicks / (dt * 1000);
					},
				},
				{
					label: 'Avg concurrent discards',
					description: 'Average number of discard (TRIM) I/Os in flight simultaneously (dc_ticks / elapsed_ms).',
					valueFn: (cur, prev, dt) => {
						const dTicks = Number(cur.dc_ticks) - Number(prev.dc_ticks);
						return dTicks / (dt * 1000);
					},
				},
				{
					label: 'Avg concurrent flushes',
					description: 'Average number of flush (fsync) I/Os in flight simultaneously (fl_ticks / elapsed_ms).',
					valueFn: (cur, prev, dt) => {
						const dTicks = Number(cur.fl_ticks) - Number(prev.fl_ticks);
						return dTicks / (dt * 1000);
					},
				},
			], 'count', runStartMs);
		pushChartMetric(chartMetrics, withChartGroup(g4, 'Block Devices', dev));
		pushChartMetric(chartMetrics, withChartGroup(g4b_queue, 'Block Devices', dev));
		const g4b = buildHostDerivedRateGroup(`disk_${dev}_latency`, 'Latency', `Disk ${dev} — Avg Latency (ms/op)`,
			devRows, [
				{
					label: 'Read ms/op',
					description: 'Average read latency per operation (rd_ticks / rd_ios) — only shown for intervals with at least one read I/O',
					valueFn: (cur, prev) => {
						const dIos = Number(cur.rd_ios) - Number(prev.rd_ios);
						if (dIos <= 0) return null;
						return (Number(cur.rd_ticks) - Number(prev.rd_ticks)) / dIos;
					},
				},
				{
					label: 'Write ms/op',
					description: 'Average write latency per operation (wr_ticks / wr_ios) — only shown for intervals with at least one write I/O',
					valueFn: (cur, prev) => {
						const dIos = Number(cur.wr_ios) - Number(prev.wr_ios);
						if (dIos <= 0) return null;
						return (Number(cur.wr_ticks) - Number(prev.wr_ticks)) / dIos;
					},
				},
				{
					label: 'Discard ms/op',
					description: 'Average discard (TRIM) latency per operation (dc_ticks / dc_ios) — only shown for intervals with at least one discard I/O',
					valueFn: (cur, prev) => {
						const dIos = Number(cur.dc_ios) - Number(prev.dc_ios);
						if (dIos <= 0) return null;
						return (Number(cur.dc_ticks) - Number(prev.dc_ticks)) / dIos;
					},
				},
				{
					label: 'Flush ms/op',
					description: 'Average flush (fsync) latency per operation (fl_ticks / fl_ios) — only shown for intervals with at least one flush I/O',
					valueFn: (cur, prev) => {
						const dIos = Number(cur.fl_ios) - Number(prev.fl_ios);
						if (dIos <= 0) return null;
						return (Number(cur.fl_ticks) - Number(prev.fl_ticks)) / dIos;
					},
				},
			], 'duration_ms', runStartMs);
		pushChartMetric(chartMetrics, withChartGroup(g4b, 'Block Devices', dev));
	}

	// Network — per interface
	const netIfaces = [...new Set(netdevRows.map(r => r.iface as string).filter(Boolean))];
	for (const iface of netIfaces) {
		const ifaceRows = netdevRows.filter(r => r.iface === iface);
		if (ifaceRows.length < 2) continue;
		const g = buildRateGroup(`net_${iface}`, 'Bandwidth', `Net ${iface} — Bandwidth (KB/s)`,
			ifaceRows, ['rx_bytes', 'tx_bytes'], 'bytes', runStartMs, 1 / 1024, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'Network', iface));
		const g2 = buildRateGroup(`net_${iface}_pkts`, 'Packets', `Net ${iface} — Packets /s`,
			ifaceRows, ['rx_packets', 'tx_packets', 'rx_errs', 'tx_errs', 'rx_drop', 'tx_drop'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g2, 'Network', iface));
		const g3 = buildRateGroup(`net_${iface}_errors`, 'Error Detail', `Net ${iface} — Error Detail /s`,
			ifaceRows, ['rx_fifo', 'rx_frame', 'tx_fifo', 'tx_colls', 'tx_carrier', 'rx_multicast'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g3, 'Network', iface));
	}

	// PSI
	if (psiRows.length > 0) {
		const g = buildInstantGroup('psi', 'Pressure (PSI)', 'Pressure Stall Index — avg10 %', psiRows,
			['cpu_some_avg10', 'memory_some_avg10', 'io_some_avg10', 'memory_full_avg10', 'io_full_avg10'],
			'percent', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'Kernel Pressure'));
		const g2 = buildInstantGroup('psi_windows', 'PSI Windows', 'Pressure Stall Index — avg60 / avg300 %', psiRows,
			['cpu_some_avg60', 'memory_some_avg60', 'io_some_avg60', 'cpu_some_avg300', 'memory_some_avg300', 'io_some_avg300'],
			'percent', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g2, 'Kernel Pressure'));
		const g3 = buildRateGroup('psi_stall_rate', 'PSI Stall Time', 'Pressure Stall Time Growth /s', psiRows,
			['cpu_some_total', 'memory_some_total', 'io_some_total', 'cpu_full_total', 'memory_full_total', 'io_full_total'],
			'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g3, 'Kernel Pressure'));
	}

	// /proc/schedstat — per CPU
	if (schedstatRows.length > 1) {
		const cpuIds = [...new Set(schedstatRows.map(r => r.cpu_id as string).filter(Boolean))];
		for (const cpuId of cpuIds) {
			const cpuRows = schedstatRows.filter(r => r.cpu_id === cpuId);
			if (cpuRows.length < 2) continue;
			const g = buildRateGroup(`sched_${cpuId}`, 'Sched', `Scheduler ${cpuId} (ns/s)`,
				cpuRows, ['run_time_ns', 'wait_time_ns', 'timeslices'], 'count', runStartMs, 1, L, D);
			pushChartMetric(chartMetrics, withChartGroup(g, 'CPU Sched', cpuId));
		}
	}

	if (fileNrRows.length > 0) {
		const g = buildInstantGroup('file_table', 'File Table', 'System File Table', fileNrRows,
			['allocated', 'max'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'Kernel Pressure'));
		const ratio = buildHostDerivedInstantGroup('file_table_usage', 'FD Capacity', 'System File Table Usage', fileNrRows, [
			{
				label: 'Allocated / max',
				description: 'Allocated file handles divided by system file-max',
				valueFn: (row) => safeRatio(toNumber(row.allocated), toNumber(row.max))
			}
		], 'percent', runStartMs);
		pushChartMetric(chartMetrics, withChartGroup(ratio, 'Kernel Pressure'));
	}

	// Summary cards
	const summary: TelemetryCard[] = [];
	const nproc = toNumber(hostConfig.nproc);
	if (nproc !== null) summary.push(metricCard('host_nproc', 'vCPU', 'count', nproc));
	const memTotalKb = toNumber(hostConfig.mem_total_kb);
	if (memTotalKb !== null) summary.push(metricCard('host_mem_total', 'Host Memory', 'bytes', memTotalKb * 1024));
	const swapTotalKb = toNumber(hostConfig.swap_total_kb);
	if (swapTotalKb !== null && swapTotalKb > 0) summary.push(metricCard('host_swap_total', 'Host Swap', 'bytes', swapTotalKb * 1024));
	const swappiness = toNumber(hostConfig.swappiness);
	if (swappiness !== null) summary.push(metricCard('host_swappiness', 'Swappiness', 'count', swappiness));
	if (statRows.length > 1) {
		const CPU_TOTAL_COLS = ['cpu_user', 'cpu_nice', 'cpu_system', 'cpu_idle', 'cpu_iowait', 'cpu_irq', 'cpu_softirq', 'cpu_steal', 'cpu_guest', 'cpu_guest_nice'];
		let maxIowaitPct = 0;
		for (let i = 1; i < statRows.length; i++) {
			const total = CPU_TOTAL_COLS.reduce((s, c) => s + Math.max(0, Number(statRows[i][c]) - Number(statRows[i-1][c])), 0);
			if (total <= 0) continue;
			const iowait = Math.max(0, Number(statRows[i].cpu_iowait) - Number(statRows[i-1].cpu_iowait));
			maxIowaitPct = Math.max(maxIowaitPct, (iowait / total) * 100);
		}
		if (maxIowaitPct > 0) summary.push(metricCard('host_cpu_iowait_peak', 'Peak IO Wait', 'percent', maxIowaitPct / 100));
	}
	if (meminfoRows.length > 0) {
		const minAvail = Math.min(...meminfoRows.map(r => Number(r.mem_available) || Infinity));
		if (isFinite(minAvail)) summary.push(metricCard('host_mem_avail_min', 'Min Avail Mem', 'bytes', minAvail * 1024));
		const maxDirty = Math.max(...meminfoRows.map(r => Number(r.dirty) || 0));
		if (maxDirty > 0) summary.push(metricCard('host_mem_dirty_peak', 'Peak Dirty', 'bytes', maxDirty * 1024));
	}
	if (psiRows.length > 0) {
		const maxIoPsi = Math.max(...psiRows.map(r => Number(r.io_full_avg10) || 0));
		if (maxIoPsi > 0) summary.push(metricCard('host_psi_io_peak', 'Peak IO PSI', 'percent', maxIoPsi / 100));
	}
	if (fileNrRows.length > 0) {
		const maxAllocated = Math.max(...fileNrRows.map(r => Number(r.allocated) || 0));
		if (maxAllocated > 0) summary.push(metricCard('host_file_alloc_peak', 'Peak Files', 'count', maxAllocated));
		const maxFileUse = Math.max(...fileNrRows.map(r => safeRatio(toNumber(r.allocated), toNumber(r.max)) ?? 0));
		if (maxFileUse > 0) summary.push(metricCard('host_file_use_peak', 'Peak File Table', 'percent', maxFileUse));
	}

	// Table: last /proc snapshot
	const tableRows: Record<string, unknown>[] = [];
	for (const [k, v] of Object.entries(hostConfig)) {
		tableRows.push({
			source: 'host config',
			metric: L[k] ?? k,
			raw: k,
			value: v,
			unit: k.endsWith('_kb') ? 'kB' : '',
			value_kind: typeof v === 'number' ? 'count' : 'text'
		});
	}
	const addLastRows = (
		source: string,
		rows: Record<string, unknown>[],
		cols: string[],
		unit = '',
		kind: TelemetryValueKind = 'count'
	) => {
		const row = rows[rows.length - 1];
		if (!row) return;
		for (const k of cols) {
			if (row[k] === null || row[k] === undefined) continue;
			tableRows.push({ source, metric: L[k] ?? k, raw: k, value: row[k], unit, value_kind: kind });
		}
	};
	addLastRows('/proc/loadavg', loadavgRows, ['load1', 'load5', 'load15', 'running_threads', 'total_threads']);
	addLastRows('/proc/stat', statRows, ['procs_running', 'procs_blocked', 'ctxt', 'processes']);
	addLastRows('/proc/vmstat', procVmstatRows, [
		'pgfault', 'pgmajfault', 'pgpgin', 'pgpgout', 'pswpin', 'pswpout',
		'pgscan_kswapd', 'pgscan_direct', 'pgsteal_kswapd', 'pgsteal_direct',
		'allocstall_normal', 'allocstall_movable', 'oom_kill',
		'workingset_refault_anon', 'workingset_refault_file',
		'thp_fault_alloc', 'thp_fault_fallback', 'thp_collapse_alloc_failed'
	]);
	addLastRows('/proc/pressure/*', psiRows, [
		'cpu_some_avg10', 'memory_some_avg10', 'io_some_avg10',
		'memory_full_avg10', 'io_full_avg10',
		'cpu_some_avg60', 'memory_some_avg60', 'io_some_avg60'
	], '%');
	addLastRows('/proc/sys/fs/file-nr', fileNrRows, ['allocated', 'max']);
	const lastMeminfo = meminfoRows[meminfoRows.length - 1];
	if (lastMeminfo) {
		for (const [k, v] of Object.entries(lastMeminfo)) {
			if (k.startsWith('_')) continue;
			tableRows.push({ source: '/proc/meminfo', metric: L[k] ?? k, raw: k, value: v, unit: 'kB', value_kind: 'count' });
		}
	}

	return {
		key: 'host_system',
		label: 'System',
		status: 'ok',
		summary,
		chartTitle: 'System metrics',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
		tableTitle: 'Last snapshot',
		tableColumns: [
			{ key: 'source', label: 'Source', kind: 'text' },
			{ key: 'metric', label: 'Metric', kind: 'text' },
			{ key: 'raw', label: 'Key', kind: 'text' },
			{ key: 'value', label: 'Value', kind: 'count' },
			{ key: 'unit', label: 'Unit', kind: 'text' }
		],
		tableRows,
		tableSnapshots: []
	};
}

// Derive a human-readable postgres process label from /proc/<pid>/cmdline.
// cmdline examples (null bytes already converted to spaces by the collection script):
//   "postgres"                                      → postmaster
//   "/usr/lib/postgresql/16/bin/postgres -D ..."   → postmaster
//   "postgres: checkpointer"                        → checkpointer
//   "postgres: background writer"                   → background writer
//   "postgres: walwriter"                           → walwriter
//   "postgres: autovacuum launcher"                 → autovacuum launcher
//   "postgres: alice mydb 127.0.0.1(54321) idle"   → alice/mydb (idle)
function formatPgProcessName(cmdline: unknown, comm: unknown): string {
	const cl = String(cmdline ?? '').trim();
	const cm = String(comm ?? '').trim();
	if (!cl) return cm || 'postgres';

	const colonIdx = cl.indexOf(': ');
	if (colonIdx === -1) return 'postmaster';

	const desc = cl.slice(colonIdx + 2).trim();
	// Known single-word or short background process names
	const bgPrefixes = [
		'checkpointer', 'background writer', 'walwriter',
		'autovacuum launcher', 'autovacuum worker',
		'logical replication launcher', 'logical replication worker',
		'stats collector', 'archiver', 'startup', 'walsender', 'walreceiver',
	];
	for (const bg of bgPrefixes) {
		if (desc.startsWith(bg)) return desc;
	}
	// Backend connection: "user database host [port] activity"
	const parts = desc.split(/\s+/);
	if (parts.length >= 3) {
		const user = parts[0];
		const db2 = parts[1];
		// activity is last token; strip parens from host:port token
		const activity = parts[parts.length - 1];
		return `${user}/${db2} (${activity})`;
	}
	return desc;
}

function latestRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
	return rows.length > 0 ? rows[rows.length - 1] : null;
}

function latestValue(rows: Record<string, unknown>[], col: string): unknown {
	for (let i = rows.length - 1; i >= 0; i--) {
		const value = rows[i][col];
		if (value !== null && value !== undefined && value !== '') return value;
	}
	return null;
}

function maxNumber(rows: Record<string, unknown>[], col: string): number | null {
	let max: number | null = null;
	for (const row of rows) {
		const value = Number(row[col]);
		if (!Number.isFinite(value)) continue;
		max = max === null ? value : Math.max(max, value);
	}
	return max;
}

function countTextValues(rows: Record<string, unknown>[], col: string): { value: string; count: number; percent: number }[] {
	const counts = new Map<string, number>();
	let total = 0;
	for (const row of rows) {
		const value = String(row[col] ?? '').trim();
		if (!value) continue;
		counts.set(value, (counts.get(value) ?? 0) + 1);
		total++;
	}
	if (total === 0) return [];
	return [...counts.entries()]
		.map(([value, count]) => ({ value, count, percent: count / total }))
		.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function mergeRowsByCollectedAt(...rowSets: Record<string, unknown>[][]): Record<string, unknown>[] {
	const byTime = new Map<string, Record<string, unknown>>();
	for (const rows of rowSets) {
		for (const row of rows) {
			const t = String(row._collected_at ?? '');
			if (!t) continue;
			const existing = byTime.get(t) ?? { _collected_at: row._collected_at };
			for (const [key, value] of Object.entries(row)) {
				if (key === '_id' || key === '_run_id') continue;
				if (value !== null && value !== undefined) existing[key] = value;
			}
			byTime.set(t, existing);
		}
	}
	return [...byTime.values()].sort((a, b) => String(a._collected_at).localeCompare(String(b._collected_at)));
}

function buildHostProcessesSection(db: Database.Database, runId: number, runStartMs: number, selectedPhases: TelemetryPhase[], benchStartedAt: string | null, postStartedAt: string | null): TelemetrySection {
	const noData: TelemetrySection = {
		key: 'host_processes',
		label: 'Processes',
		status: 'no_data',
		reason: 'No per-process metrics collected. Requires SSH enabled on the server configuration.',
		summary: [], chartTitle: '', chartSeries: [],
		tableTitle: '', tableColumns: [], tableRows: [], tableSnapshots: []
	};

	const fetchH = (t: string) => fetchHostRows(db, t, runId, selectedPhases, benchStartedAt, postStartedAt);
	const pidStatRows      = fetchH('host_snap_proc_pid_stat');
	const pidStatmRows     = fetchH('host_snap_proc_pid_statm');
	const pidIoRows        = fetchH('host_snap_proc_pid_io');
	const pidStatusRows    = fetchH('host_snap_proc_pid_status');
	const pidSchedstatRows = fetchH('host_snap_proc_pid_schedstat');
	const pidFdRows        = fetchH('host_snap_proc_pid_fd_count');
	const pidWchanRows     = fetchH('host_snap_proc_pid_wchan');

	const allPids = [...new Set([
		...pidStatRows.map(r => r.pid as number),
		...pidStatmRows.map(r => r.pid as number),
		...pidIoRows.map(r => r.pid as number),
		...pidStatusRows.map(r => r.pid as number),
		...pidSchedstatRows.map(r => r.pid as number),
		...pidFdRows.map(r => r.pid as number),
		...pidWchanRows.map(r => r.pid as number),
	].filter(p => p != null))];

	if (allPids.length === 0) return noData;

	function scoreDelta(rows: Record<string, unknown>[], col: string): number {
		if (rows.length < 2) return 0;
		const first = toNumber(rows[0][col]);
		const last = toNumber(rows[rows.length - 1][col]);
		if (first === null || last === null || last < first) return 0;
		return last - first;
	}

	function pidScore(pid: number): number {
		const pStatRows = pidStatRows.filter(r => r.pid === pid);
		const pIoRows = pidIoRows.filter(r => r.pid === pid);
		const pSchedRows = pidSchedstatRows.filter(r => r.pid === pid);
		const pStatusRows = pidStatusRows.filter(r => r.pid === pid);
		const pFdRows = pidFdRows.filter(r => r.pid === pid);

		return (
			scoreDelta(pStatRows, 'utime') +
			scoreDelta(pStatRows, 'stime') +
			scoreDelta(pStatRows, 'majflt') * 1000 +
			scoreDelta(pIoRows, 'read_bytes') / 1024 +
			scoreDelta(pIoRows, 'write_bytes') / 1024 +
			scoreDelta(pSchedRows, 'wait_time_ns') / 1_000_000 +
			(maxNumber(pStatusRows, 'vm_rss_kb') ?? 0) / 1024 +
			(maxNumber(pStatusRows, 'vm_swap_kb') ?? 0) / 1024 +
			(maxNumber(pFdRows, 'fd_count') ?? 0)
		);
	}

	const displayedPids = [...allPids]
		.sort((a, b) => {
			const byScore = pidScore(b) - pidScore(a);
			return byScore !== 0 ? byScore : a - b;
		});

	const L = HOST_COL_LABELS;
	const D = HOST_COL_DESCS;
	const chartMetrics: TelemetryChartMetric[] = [];
	const summary: TelemetryCard[] = [];

	// tableRows doubles as the process list consumed by HostProcessPanel.
	const tableRows: Record<string, unknown>[] = [];

	for (const pid of displayedPids) {
		const pStatRows  = pidStatRows.filter(r => r.pid === pid);
		const pStatmRows = pidStatmRows.filter(r => r.pid === pid);
		const pIoRows    = pidIoRows.filter(r => r.pid === pid);
		const pStatusRows = pidStatusRows.filter(r => r.pid === pid);
		const pSchedRows = pidSchedstatRows.filter(r => r.pid === pid);
		const pFdRows = pidFdRows.filter(r => r.pid === pid);
		const pWchanRows = pidWchanRows.filter(r => r.pid === pid);

		// Use the first row that has cmdline; fall back to comm
		const firstStat = pStatRows[0];
		const firstStatus = pStatusRows[0];
		const comm       = ((firstStat?.comm ?? firstStatus?.name) as string) ?? '';
		const cmdline    = (firstStat?.cmdline as string) ?? '';
		const processName = formatPgProcessName(cmdline, comm);
		const tag = `${processName} (${pid})`;

		if (pStatRows.length > 1) {
			const g = buildRateGroup(`pid_${pid}_cpu`, `${tag} — CPU`, `${tag} — CPU jiffies /s`,
				pStatRows, ['utime', 'stime'], 'count', runStartMs, 1, L, D);
			if (g) chartMetrics.push(g);

			const faults = buildRateGroup(`pid_${pid}_faults`, `${tag} — Faults`, `${tag} — Page Faults /s`,
				pStatRows, ['minflt', 'majflt'], 'count', runStartMs, 1, L, D);
			if (faults) chartMetrics.push(faults);
		}
		if (pStatusRows.length > 0) {
			const g = buildInstantGroup(`pid_${pid}_mem`, `${tag} — Mem`, `${tag} — Memory (bytes)`,
				pStatusRows, ['vm_rss_kb', 'rss_anon_kb', 'rss_file_kb', 'rss_shmem_kb', 'vm_size_kb', 'vm_peak_kb', 'vm_swap_kb'], 'bytes', runStartMs, 1024, L, D);
			if (g) chartMetrics.push(g);
		} else if (pStatmRows.length > 0) {
			const g = buildInstantGroup(`pid_${pid}_mem`, `${tag} — Mem`, `${tag} — Memory (pages)`,
				pStatmRows, ['size', 'resident', 'shared', 'text', 'data'], 'count', runStartMs, 1, L, D);
			if (g) chartMetrics.push(g);
		}
		if (pIoRows.length > 1) {
			const g = buildRateGroup(`pid_${pid}_io_bytes`, `${tag} — I/O Bytes`, `${tag} — I/O Bytes (KB/s)`,
				pIoRows, ['read_bytes', 'write_bytes', 'cancelled_write_bytes'], 'bytes', runStartMs, 1 / 1024, L, D);
			if (g) chartMetrics.push(g);

			const chars = buildRateGroup(`pid_${pid}_io_chars`, `${tag} — I/O Chars`, `${tag} — I/O Chars /s`,
				pIoRows, ['rchar', 'wchar'], 'bytes', runStartMs, 1, L, D);
			if (chars) chartMetrics.push(chars);

			const syscalls = buildRateGroup(`pid_${pid}_io_syscalls`, `${tag} — I/O Syscalls`, `${tag} — I/O Syscalls /s`,
				pIoRows, ['syscr', 'syscw'], 'count', runStartMs, 1, L, D);
			if (syscalls) chartMetrics.push(syscalls);
		}
		if (pSchedRows.length > 1) {
			const g = buildRateGroup(`pid_${pid}_sched`, `${tag} — Sched`, `${tag} — Scheduler (ns/s)`,
				pSchedRows, ['run_time_ns', 'wait_time_ns'], 'count', runStartMs, 1, L, D);
			if (g) chartMetrics.push(g);

			const slices = buildRateGroup(`pid_${pid}_timeslices`, `${tag} — Timeslices`, `${tag} — Scheduler Timeslices /s`,
				pSchedRows, ['timeslices'], 'count', runStartMs, 1, L, D);
			if (slices) chartMetrics.push(slices);
		}
		if (pStatusRows.length > 1) {
			const ctx = buildRateGroup(`pid_${pid}_ctx`, `${tag} — Ctx`, `${tag} — Context Switches /s`,
				pStatusRows, ['vol_ctxt_sw', 'nvol_ctxt_sw'], 'count', runStartMs, 1, L, D);
			if (ctx) chartMetrics.push(ctx);
		}
		if (pStatusRows.length > 0) {
			const threads = buildInstantGroup(`pid_${pid}_threads`, `${tag} — Threads`, `${tag} — Threads`,
				pStatusRows, ['threads'], 'count', runStartMs, 1, L, D);
			if (threads) chartMetrics.push(threads);
		} else if (pStatRows.length > 0) {
			const threads = buildInstantGroup(`pid_${pid}_threads`, `${tag} — Threads`, `${tag} — Threads`,
				pStatRows, ['num_threads'], 'count', runStartMs, 1, L, D);
			if (threads) chartMetrics.push(threads);
		}
		if (pFdRows.length > 0 || pStatusRows.length > 0) {
			const fdMetricRows = mergeRowsByCollectedAt(pFdRows, pStatusRows);
			const fds = buildInstantGroup(`pid_${pid}_fds`, `${tag} — FDs`, `${tag} — File Descriptors`,
				fdMetricRows, ['fd_count', 'fd_size'], 'count', runStartMs, 1, L, D);
			if (fds) chartMetrics.push(fds);
		}

		// Summary: peak resident pages per process
		const peakRssKb = maxNumber(pStatusRows, 'vm_rss_kb');
		const peakResidentPages = maxNumber(pStatmRows, 'resident');
		if (peakRssKb !== null && peakRssKb > 0) {
			summary.push(metricCard(`pid_${pid}_rss_peak`, `${processName} Peak RSS`, 'bytes', peakRssKb * 1024));
		} else if (peakResidentPages !== null && peakResidentPages > 0) {
			summary.push(metricCard(`pid_${pid}_res_peak`, `${processName} Peak RSS`, 'count', peakResidentPages));
		}

		// Row used by HostProcessPanel for the process dropdown
		const lastStatm = pStatmRows[pStatmRows.length - 1];
		const lastStatus = latestRow(pStatusRows);
		const lastFd = latestRow(pFdRows);
		const lastWchan = latestRow(pWchanRows);
		const wchanDistribution = countTextValues(pWchanRows, 'wchan');
		tableRows.push({
			pid,
			processName,
			comm,
			cmdline,
			state: latestValue(pStatusRows, 'state') ?? latestValue(pStatRows, 'state'),
			wchan: lastWchan?.wchan ?? null,
			top_wchan: wchanDistribution[0]?.value ?? null,
			wchan_sample_count: wchanDistribution.reduce((total, item) => total + item.count, 0),
			wchan_distribution: wchanDistribution,
			cpu_jiffies_delta: scoreDelta(pStatRows, 'utime') + scoreDelta(pStatRows, 'stime'),
			major_faults_delta: scoreDelta(pStatRows, 'majflt'),
			resident: lastStatm?.resident ?? null,
			data:     lastStatm?.data     ?? null,
			shared:   lastStatm?.shared   ?? null,
			vm_rss_kb: lastStatus?.vm_rss_kb ?? null,
			peak_vm_rss_kb: peakRssKb,
			vm_size_kb: lastStatus?.vm_size_kb ?? null,
			vm_swap_kb: lastStatus?.vm_swap_kb ?? null,
			peak_vm_swap_kb: maxNumber(pStatusRows, 'vm_swap_kb'),
			rss_anon_kb: lastStatus?.rss_anon_kb ?? null,
			rss_file_kb: lastStatus?.rss_file_kb ?? null,
			rss_shmem_kb: lastStatus?.rss_shmem_kb ?? null,
			threads: lastStatus?.threads ?? latestValue(pStatRows, 'num_threads'),
			peak_threads: maxNumber(pStatusRows, 'threads') ?? maxNumber(pStatRows, 'num_threads'),
			fd_count: lastFd?.fd_count ?? null,
			fd_size: lastStatus?.fd_size ?? null,
			peak_resident_pages: peakResidentPages,
			peak_fd_count: maxNumber(pFdRows, 'fd_count'),
			latest_read_bytes: latestValue(pIoRows, 'read_bytes'),
			latest_write_bytes: latestValue(pIoRows, 'write_bytes'),
			read_bytes_delta: scoreDelta(pIoRows, 'read_bytes'),
			write_bytes_delta: scoreDelta(pIoRows, 'write_bytes'),
			sched_wait_ms_delta: scoreDelta(pSchedRows, 'wait_time_ns') / 1_000_000,
		});
	}

	if (chartMetrics.length === 0) return noData;

	return {
		key: 'host_processes',
		label: 'Processes',
		status: 'ok',
		summary,
		chartTitle: 'Process metrics',
		chartSeries: chartMetrics[0]?.series ?? [],
		chartMetrics,
		defaultChartMetricKey: chartMetrics[0]?.key,
		tableTitle: 'Process details (last snapshot)',
		tableColumns: [
			{ key: 'pid',         label: 'PID',            kind: 'count' },
			{ key: 'processName', label: 'Process',        kind: 'text'  },
			{ key: 'state',       label: 'State',          kind: 'text'  },
			{ key: 'wchan',       label: 'Wait channel',   kind: 'text'  },
			{ key: 'top_wchan',   label: 'Top wait',       kind: 'text'  },
			{ key: 'wchan_sample_count', label: 'Wait samples', kind: 'count' },
			{ key: 'vm_rss_kb',   label: 'RSS kB',         kind: 'count' },
			{ key: 'peak_vm_rss_kb', label: 'Peak RSS kB', kind: 'count' },
			{ key: 'vm_swap_kb',  label: 'Swap kB',        kind: 'count' },
			{ key: 'threads',     label: 'Threads',        kind: 'count' },
			{ key: 'fd_count',    label: 'Open FDs',       kind: 'count' },
			{ key: 'cpu_jiffies_delta', label: 'CPU jiffies', kind: 'count' },
			{ key: 'major_faults_delta', label: 'Major faults', kind: 'count' },
			{ key: 'read_bytes_delta', label: 'Read bytes', kind: 'bytes' },
			{ key: 'write_bytes_delta', label: 'Write bytes', kind: 'bytes' },
			{ key: 'sched_wait_ms_delta', label: 'Sched wait', kind: 'duration_ms' },
			{ key: 'resident',    label: 'Resident pages', kind: 'count' },
			{ key: 'data',        label: 'Data pages',     kind: 'count' },
			{ key: 'shared',      label: 'Shared pages',   kind: 'count' },
			{ key: 'cmdline',     label: 'Full cmdline',   kind: 'text'  },
		],
		tableRows,
		tableSnapshots: []
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
	const walSection = buildWalSection(walRows, runStartMs, databaseRows);
	const sections: TelemetrySection[] = [
		databaseSection,
		buildIoSection(ioRows, runStartMs, databaseRows),
		walSection,
		buildBgwriterSection(bgwriterRows, runStartMs, databaseRows),
		buildCheckpointerSection(checkpointerRows, runStartMs, databaseRows),
		buildArchiverSection(archiverRows, runStartMs),
		buildUserTablesSection(userTableRows, runStartMs),
		buildUserIndexesSection(userIndexRows, runStartMs),
		buildStatioUserTablesSection(statioUserTableRows, runStartMs),
		buildStatioUserIndexesSection(statioUserIndexRows, runStartMs),
		buildStatioUserSequencesSection(statioUserSequenceRows, runStartMs),
		buildHostSystemSection(db, runId, runStartMs, selectedPhases, run.bench_started_at, run.post_started_at),
		buildHostProcessesSection(db, runId, runStartMs, selectedPhases, run.bench_started_at, run.post_started_at),
		buildCloudWatchSection(db, runId, runStartMs, selectedPhases)
	];

	const markers: TelemetryMarker[] = [];
	const benchMarker = toMs(run.bench_started_at);
	if (benchMarker !== null) markers.push({ t: benchMarker - runStartMs, label: 'bench', color: '#0066cc' });
	const postMarker = toMs(run.post_started_at);
	if (postMarker !== null) markers.push({ t: postMarker - runStartMs, label: 'post', color: '#e6531d' });

	const databaseTransactions = sum([delta(databaseRows, 'xact_commit'), delta(databaseRows, 'xact_rollback')]);
	const databaseTempBytes = delta(databaseRows, 'temp_bytes');
	const databaseTps = safeRatio(databaseTransactions, elapsedSeconds(databaseRows));
	const databaseBufferHitRatio = safeRatio(delta(databaseRows, 'blks_hit'), sum([delta(databaseRows, 'blks_hit'), delta(databaseRows, 'blks_read')]));
	const walBytes = delta(walRows, 'wal_bytes');

	const heroCards: TelemetryCard[] = [
		metricCard('transactions', 'Transactions', 'count', databaseTransactions),
		metricCard('db_tps', 'DB-stat TPS', 'tps', databaseTps),
		metricCard('buffer_hit_ratio', 'Buffer Hit Ratio', 'percent', databaseBufferHitRatio),
		metricCard('wal_bytes', 'WAL Bytes', 'bytes', walBytes),
		metricCard('wal_per_tx', 'WAL / Tx', 'bytes', safeRatio(walBytes, databaseTransactions)),
		metricCard('temp_bytes', 'Temp Bytes', 'bytes', databaseTempBytes),
		metricCard('temp_bytes_per_tx', 'Temp / Tx', 'bytes', safeRatio(databaseTempBytes, databaseTransactions)),
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
