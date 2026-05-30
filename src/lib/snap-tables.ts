// Supported pg_stat view names for mybench (PG 18+, hardcoded).
// Matches the keys of SNAP_TABLE_MAP in src/lib/server/pg-stats.ts, plus
// pg_stat_statements which is collected once at bench end (not on interval).
// Kept as a shared (non-server) module so client-side code can import it.
export const SUPPORTED_SNAP_TABLES = [
	'pg_stat_activity',
	'pg_stat_archiver',
	'pg_stat_bgwriter',
	'pg_stat_checkpointer',
	'pg_stat_database',
	'pg_stat_database_conflicts',
	'pg_stat_io',
	'pg_stat_replication',
	'pg_stat_replication_slots',
	'pg_stat_slru',
	'pg_stat_statements',          // collected once at bench end, not on interval
	'pg_stat_subscription',
	'pg_stat_subscription_stats',
	'pg_stat_user_functions',
	'pg_stat_user_indexes',
	'pg_stat_user_tables',
	'pg_stat_wal',
	'pg_statio_user_indexes',
	'pg_statio_user_sequences',
	'pg_statio_user_tables'
] as const;

export type SnapTableName = (typeof SUPPORTED_SNAP_TABLES)[number];
