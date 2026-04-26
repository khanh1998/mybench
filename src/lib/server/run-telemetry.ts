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
	kind: TelemetryValueKind;
	title: string;
	series: TelemetrySeries[];
	group?: string;
	entity?: string;
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

// Fetch all rows from a host_snap_* table ordered by collection time.
function fetchHostRows(db: Database.Database, tableName: string, runId: number): Record<string, unknown>[] {
	if (!tableExists(db, tableName)) return [];
	try {
		return db.prepare(`SELECT * FROM ${tableName} WHERE _run_id = ? ORDER BY _collected_at`).all(runId) as Record<string, unknown>[];
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
	let colorIdx = 0;
	for (const col of cols) {
		const points: TelemetrySeriesPoint[] = [];
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
				color: COLORS[colorIdx++ % COLORS.length],
				points
			});
		}
	}
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
	// vmstat CPU
	us: 'User %', sy: 'System %', wa: 'IO Wait %', st: 'Stolen %', id: 'Idle %',
	// vmstat misc
	intr: 'Interrupts/s', cs: 'Ctx switches/s',
	si: 'Swap in (pg/s)', so: 'Swap out (pg/s)',
	r: 'Run queue', b: 'Uninterruptible',
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
	// vmstat CPU
	us: 'CPU time in user space (non-kernel processes)',
	sy: 'CPU time in kernel space (system calls, drivers)',
	wa: 'CPU idle time waiting for I/O to complete',
	st: 'CPU time stolen by the hypervisor (VMs only)',
	id: 'CPU completely idle',
	// vmstat misc
	intr: 'Hardware and software interrupts per second',
	cs: 'Process/thread context switches per second',
	si: 'Pages swapped in from disk per second',
	so: 'Pages swapped out to disk per second',
	r: 'Processes waiting to run (run queue length)',
	b: 'Processes in uninterruptible sleep (blocked on I/O)',
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

function buildHostSystemSection(db: Database.Database, runId: number, runStartMs: number): TelemetrySection {
	const noData: TelemetrySection = {
		key: 'host_system',
		label: 'System',
		status: 'no_data',
		reason: 'No host OS metrics collected. Requires SSH enabled on the server configuration.',
		summary: [], chartTitle: '', chartSeries: [],
		tableTitle: '', tableColumns: [], tableRows: [], tableSnapshots: []
	};

	const vmstatRows     = fetchHostRows(db, 'host_snap_vmstat', runId);
	const loadavgRows    = fetchHostRows(db, 'host_snap_proc_loadavg', runId);
	const meminfoRows    = fetchHostRows(db, 'host_snap_proc_meminfo', runId);
	const statRows       = fetchHostRows(db, 'host_snap_proc_stat', runId);
	const procVmstatRows = fetchHostRows(db, 'host_snap_proc_vmstat', runId);
	const diskstatsRows  = fetchHostRows(db, 'host_snap_proc_diskstats', runId);
	const netdevRows     = fetchHostRows(db, 'host_snap_proc_netdev', runId);
	const schedstatRows  = fetchHostRows(db, 'host_snap_proc_schedstat', runId);
	const psiRows        = fetchHostRows(db, 'host_snap_proc_psi', runId);
	const fileNrRows     = fetchHostRows(db, 'host_snap_proc_sys_fs_file_nr', runId);
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

	const hasData = vmstatRows.length > 0 || loadavgRows.length > 0 || meminfoRows.length > 0
		|| statRows.length > 0 || diskstatsRows.length > 0 || fileNrRows.length > 0
		|| Object.keys(hostConfig).length > 0;
	if (!hasData) return noData;

	const L = HOST_COL_LABELS;
	const D = HOST_COL_DESCS;
	const chartMetrics: TelemetryChartMetric[] = [];

	// CPU — vmstat already outputs per-second values
	if (vmstatRows.length > 0) {
		const g = buildInstantGroup('cpu', 'CPU %', 'CPU Usage (%)', vmstatRows,
			['us', 'sy', 'wa', 'st', 'id'], 'percent', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'CPU'));
		const g2 = buildInstantGroup('ctx_sw', 'Ctx & Interrupts', 'Context Switches & Interrupts /s', vmstatRows,
			['intr', 'cs'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g2, 'CPU'));
		const g3 = buildInstantGroup('swap_rate', 'Swap I/O', 'Swap Page Rate /s', vmstatRows,
			['si', 'so'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g3, 'Memory'));
	}

	// Load average
	if (loadavgRows.length > 0) {
		const g = buildInstantGroup('load_avg', 'Load Average', 'Load Average', loadavgRows,
			['load1', 'load5', 'load15', 'running_threads'], 'count', runStartMs, 1, L, D);
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
		const g = buildRateGroup('stat_cpu', 'CPU Jiffies', 'CPU Jiffies /s (/proc/stat)', statRows,
			['cpu_user', 'cpu_nice', 'cpu_system', 'cpu_iowait', 'cpu_steal', 'cpu_irq', 'cpu_softirq'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'CPU'));
		const g2 = buildRateGroup('stat_ctx', 'Ctx & Forks', 'Context Switches & Forks /s', statRows,
			['ctxt', 'processes'], 'count', runStartMs, 1, L, D);
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
			['rd_ios', 'wr_ios'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g, 'Block Devices', dev));
		const g2 = buildRateGroup(`disk_${dev}_bytes`, 'Throughput', `Disk ${dev} — Throughput (sectors/s)`, devRows,
			['rd_sectors', 'wr_sectors'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g2, 'Block Devices', dev));
		const g2b = buildRateGroup(`disk_${dev}_merges`, 'Merges', `Disk ${dev} — Request Merges /s`, devRows,
			['rd_merges', 'wr_merges'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g2b, 'Block Devices', dev));
		const g3 = buildInstantGroup(`disk_${dev}_queue`, 'Queue', `Disk ${dev} — In-flight I/Os`, devRows,
			['in_flight'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g3, 'Block Devices', dev));
		const g4 = buildRateGroup(`disk_${dev}_time`, 'Latency', `Disk ${dev} — I/O Wait (ms/s)`, devRows,
			['rd_ticks', 'wr_ticks', 'io_ticks', 'time_in_queue'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g4, 'Block Devices', dev));
		const g5 = buildRateGroup(`disk_${dev}_discard_flush`, 'Discard/Flush', `Disk ${dev} — Discard and Flush Activity`, devRows,
			['dc_ios', 'dc_sectors', 'dc_ticks', 'fl_ios', 'fl_ticks'], 'count', runStartMs, 1, L, D);
		pushChartMetric(chartMetrics, withChartGroup(g5, 'Block Devices', dev));
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
			const g = buildRateGroup(`sched_${cpuId}`, `${cpuId} Sched`, `Scheduler ${cpuId} (ns/s)`,
				cpuRows, ['run_time_ns', 'wait_time_ns', 'timeslices'], 'count', runStartMs, 1, L, D);
			pushChartMetric(chartMetrics, withChartGroup(g, 'CPU'));
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
	if (vmstatRows.length > 0) {
		const maxWa = Math.max(...vmstatRows.map(r => Number(r.wa) || 0));
		summary.push(metricCard('host_cpu_iowait_peak', 'Peak IO Wait', 'percent', maxWa / 100));
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

	// Table: last vmstat + meminfo snapshot
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
	const lastVmstat = vmstatRows[vmstatRows.length - 1];
	if (lastVmstat) {
		for (const [k, v] of Object.entries(lastVmstat)) {
			if (k.startsWith('_')) continue;
			tableRows.push({ source: 'vmstat', metric: L[k] ?? k, raw: k, value: v, unit: '', value_kind: 'count' });
		}
	}
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

function buildHostProcessesSection(db: Database.Database, runId: number, runStartMs: number): TelemetrySection {
	const noData: TelemetrySection = {
		key: 'host_processes',
		label: 'Processes',
		status: 'no_data',
		reason: 'No per-process metrics collected. Requires SSH enabled on the server configuration.',
		summary: [], chartTitle: '', chartSeries: [],
		tableTitle: '', tableColumns: [], tableRows: [], tableSnapshots: []
	};

	const pidStatRows      = fetchHostRows(db, 'host_snap_proc_pid_stat', runId);
	const pidStatmRows     = fetchHostRows(db, 'host_snap_proc_pid_statm', runId);
	const pidIoRows        = fetchHostRows(db, 'host_snap_proc_pid_io', runId);
	const pidStatusRows    = fetchHostRows(db, 'host_snap_proc_pid_status', runId);
	const pidSchedstatRows = fetchHostRows(db, 'host_snap_proc_pid_schedstat', runId);
	const pidFdRows        = fetchHostRows(db, 'host_snap_proc_pid_fd_count', runId);
	const pidWchanRows     = fetchHostRows(db, 'host_snap_proc_pid_wchan', runId);

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
		})
		.slice(0, 12);

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
		buildHostSystemSection(db, runId, runStartMs),
		buildHostProcessesSection(db, runId, runStartMs),
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
