import pg from 'pg';
import getDb from './db';
import { getPgStatStatementsSqliteType } from './pg-stat-statements-schema';

// Mapping from pg_stat view names to our snap_ table names
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

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

async function getPgStatStatementsSchema(pool: pg.Pool): Promise<string | null> {
	const result = await pool.query<{
		schema_name: string;
	}>(
		`SELECT n.nspname AS schema_name
		FROM pg_extension e
		JOIN pg_namespace n ON n.oid = e.extnamespace
		WHERE e.extname = 'pg_stat_statements'
		LIMIT 1`
	);

	if (result.rows.length === 0) {
		return null;
	}

	return result.rows[0].schema_name;
}

export async function collectSnapshot(
	pgPool: pg.Pool,
	runId: number,
	enabledTables: string[],
	phase: 'pre' | 'bench' | 'post'
): Promise<void> {
	const db = getDb();
	const collectedAt = new Date().toISOString();

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
				_phase TEXT NOT NULL DEFAULT 'bench'
			)`);
			const existingCols = new Set(
				(db.prepare(`PRAGMA table_info(${snapTable})`).all() as { name: string }[]).map(r => r.name)
			);
			for (const col of cols) {
				if (!existingCols.has(col)) {
					db.exec(`ALTER TABLE ${snapTable} ADD COLUMN ${col} TEXT`);
				}
			}

			const insertCols = ['_run_id', '_collected_at', '_phase', ...cols];
			const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
			const stmt = db.prepare(
				`INSERT INTO ${snapTable} (${insertCols.join(', ')}) VALUES (${placeholders})`
			);

			const insertMany = db.transaction((rows: Record<string, unknown>[]) => {
				for (const row of rows) {
					const params: Record<string, unknown> = {
						p0: runId,
						p1: collectedAt,
						p2: phase
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

export async function resetPgStatStatements(pgPool: pg.Pool): Promise<{ warning?: string }> {
	try {
		const schemaName = await getPgStatStatementsSchema(pgPool);
		if (!schemaName) {
			return { warning: 'pg_stat_statements is not installed on this PostgreSQL server. Skipping reset.' };
		}

		const resetFn = `${quoteIdentifier(schemaName)}.${quoteIdentifier('pg_stat_statements_reset')}`;
		await pgPool.query(`SELECT ${resetFn}()`);
		return {};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { warning: `Could not reset pg_stat_statements: ${message}` };
	}
}

export async function collectPgStatStatementsSnapshot(
	pgPool: pg.Pool,
	runId: number,
	stepId: number
): Promise<{ rowCount: number; warning?: string }> {
	try {
		const schemaName = await getPgStatStatementsSchema(pgPool);
		if (!schemaName) {
			return { rowCount: 0, warning: 'pg_stat_statements is not installed on this PostgreSQL server. Skipping collection.' };
		}
		const relation = `${quoteIdentifier(schemaName)}.${quoteIdentifier('pg_stat_statements')}`;

		const result = await pgPool.query(
			`SELECT *
			FROM ${relation}
			WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`
		);
		if (result.rows.length === 0) {
			return { rowCount: 0 };
		}

		const db = getDb();
		const collectedAt = new Date().toISOString();
		const cols = result.fields.map((f: pg.FieldDef) => f.name);
		const existingCols = new Set(
			(db.prepare(`PRAGMA table_info(snap_pg_stat_statements)`).all() as { name: string }[]).map((r) => r.name)
		);
		for (const col of cols) {
			if (!existingCols.has(col)) {
				db.exec(`ALTER TABLE snap_pg_stat_statements ADD COLUMN ${col} ${getPgStatStatementsSqliteType(col)}`);
			}
		}

		const insertCols = ['_run_id', '_step_id', '_collected_at', ...cols];
		const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
		const stmt = db.prepare(
			`INSERT INTO snap_pg_stat_statements (${insertCols.join(', ')}) VALUES (${placeholders})`
		);
		const insertMany = db.transaction((rows: Record<string, unknown>[]) => {
			for (const row of rows) {
				const params: Record<string, unknown> = {
					p0: runId,
					p1: stepId,
					p2: collectedAt
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
		return { rowCount: result.rows.length };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { rowCount: 0, warning: `Could not read pg_stat_statements: ${message}` };
	}
}

/** Raw snapshot of pg_locks — analysis (blocking tree) computed in the UI. */
export async function collectPgLocksSnapshot(
	pgPool: pg.Pool,
	runId: number,
	phase: 'pre' | 'bench' | 'post'
): Promise<void> {
	try {
		const result = await pgPool.query(`
			SELECT locktype,
			       database, relation, page, tuple,
			       virtualxid, transactionid::text,
			       classid, objid, objsubid,
			       virtualtransaction, pid, mode,
			       granted::int, fastpath::int
			FROM pg_catalog.pg_locks
			WHERE pid IS NOT NULL
		`);
		if (result.rows.length === 0) return;
		const db = getDb();
		const collectedAt = new Date().toISOString();
		const cols = ['locktype', 'database', 'relation', 'page', 'tuple', 'virtualxid', 'transactionid', 'classid', 'objid', 'objsubid', 'virtualtransaction', 'pid', 'mode', 'granted', 'fastpath'];
		const insertCols = ['_run_id', '_collected_at', '_phase', ...cols];
		const placeholders = insertCols.map((_, i) => `@p${i}`).join(', ');
		const stmt = db.prepare(
			`INSERT INTO snap_pg_locks (${insertCols.join(', ')}) VALUES (${placeholders})`
		);
		const insertMany = db.transaction((rows: Record<string, unknown>[]) => {
			for (const row of rows) {
				const params: Record<string, unknown> = { p0: runId, p1: collectedAt, p2: phase };
				cols.forEach((col, i) => { params[`p${i + 3}`] = row[col] ?? null; });
				stmt.run(params);
			}
		});
		insertMany(result.rows);
	} catch (_err) {
		// pg_locks always exists; ignore errors (e.g. permission issues in some setups)
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
