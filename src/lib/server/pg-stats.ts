// Mapping from pg_stat view names to our snap_ table names.
// Used by plan-generator, mcp/tools, services/pg-servers, and api/snap-tables.
export const SNAP_TABLE_MAP: Record<string, string> = {
	pg_stat_database: 'snap_pg_stat_database',
	pg_stat_bgwriter: 'snap_pg_stat_bgwriter',
	pg_stat_checkpointer: 'snap_pg_stat_checkpointer',
	pg_stat_user_tables: 'snap_pg_stat_user_tables',
	pg_stat_user_indexes: 'snap_pg_stat_user_indexes',
	pg_statio_user_tables: 'snap_pg_statio_user_tables',
	pg_statio_user_indexes: 'snap_pg_statio_user_indexes',
	pg_statio_user_sequences: 'snap_pg_statio_user_sequences',
	pg_stat_database_conflicts: 'snap_pg_stat_database_conflicts',
	pg_stat_archiver: 'snap_pg_stat_archiver',
	pg_stat_slru: 'snap_pg_stat_slru',
	pg_stat_user_functions: 'snap_pg_stat_user_functions',
	pg_stat_wal: 'snap_pg_stat_wal',
	pg_stat_replication_slots: 'snap_pg_stat_replication_slots',
	pg_stat_io: 'snap_pg_stat_io',
	pg_stat_activity: 'snap_pg_stat_activity',
	pg_stat_replication: 'snap_pg_stat_replication',
	pg_stat_subscription: 'snap_pg_stat_subscription',
	pg_stat_subscription_stats: 'snap_pg_stat_subscription_stats'
};

export const ALL_SNAP_TABLES = Object.values(SNAP_TABLE_MAP);
