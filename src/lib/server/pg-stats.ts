import pg from 'pg';
import getDb from './db';

// Mapping from pg_stat view names to our snap_ table names
export const SNAP_TABLE_MAP: Record<string, string> = {
	pg_stat_database: 'snap_pg_stat_database',
	pg_stat_bgwriter: 'snap_pg_stat_bgwriter',
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

export async function collectSnapshot(
	pgPool: pg.Pool,
	runId: number,
	enabledTables: string[],
	isBaseline: boolean
): Promise<void> {
	const db = getDb();
	const collectedAt = new Date().toISOString();
	const isBaselineInt = isBaseline ? 1 : 0;

	for (const tableName of enabledTables) {
		const snapTable = SNAP_TABLE_MAP[tableName];
		if (!snapTable) continue;

		try {
			const result = await pgPool.query(`SELECT * FROM pg_catalog.${tableName}`);
			if (result.rows.length === 0) continue;

			const cols = result.fields.map((f: pg.FieldDef) => f.name);

			// Ensure snap table exists and has all columns PG returned
			db.exec(`CREATE TABLE IF NOT EXISTS ${snapTable} (
				_id INTEGER PRIMARY KEY AUTOINCREMENT,
				_run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
				_collected_at TEXT NOT NULL,
				_is_baseline INTEGER NOT NULL DEFAULT 0
			)`);
			const existingCols = new Set(
				(db.prepare(`PRAGMA table_info(${snapTable})`).all() as { name: string }[]).map(r => r.name)
			);
			for (const col of cols) {
				if (!existingCols.has(col)) {
					db.exec(`ALTER TABLE ${snapTable} ADD COLUMN ${col} TEXT`);
				}
			}

			const insertCols = ['_run_id', '_collected_at', '_is_baseline', ...cols];
			const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
			const stmt = db.prepare(
				`INSERT INTO ${snapTable} (${insertCols.join(', ')}) VALUES (${placeholders})`
			);

			const insertMany = db.transaction((rows: Record<string, unknown>[]) => {
				for (const row of rows) {
					const params: Record<string, unknown> = {
						p0: runId,
						p1: collectedAt,
						p2: isBaselineInt
					};
					cols.forEach((col: string, i: number) => {
						const val = row[col];
						params[`p${i + 3}`] =
							val instanceof Date ? val.toISOString() :
							typeof val === 'boolean' ? (val ? 1 : 0) :
							val ?? null;
					});
					stmt.run(params);
				}
			});

			insertMany(result.rows);
		} catch (_err) {
			// Skip tables that fail (permissions, etc.)
		}
	}
}

export function getEnabledTablesForRun(serverId: number): string[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT table_name FROM pg_stat_table_selections WHERE server_id = ? AND enabled = 1`
		)
		.all(serverId) as { table_name: string }[];
	return rows.map((r) => r.table_name).filter((t) => t in SNAP_TABLE_MAP);
}
