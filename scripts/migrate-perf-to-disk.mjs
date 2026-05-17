import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const dbPath = join(process.cwd(), 'data', 'mybench.db');
const perfScriptDir = 'data/perf';

function perfScriptPath(runId, stepId, mode) {
	const safeMode = String(mode || 'record').replace(/[^a-zA-Z0-9_-]/g, '_');
	return `${perfScriptDir}/${runId}_${stepId}_${safeMode}.perf_script`;
}

mkdirSync(perfScriptDir, { recursive: true });

const db = new Database(dbPath);

const rows = db
	.prepare(`
		SELECT id, run_id, step_id, mode, perf_script_output
		FROM run_step_perf
		WHERE perf_script_output <> ''
			AND perf_script_output NOT LIKE 'data/perf/%'
	`)
	.all();

const update = db.prepare(`
	UPDATE run_step_perf
	SET perf_script_output = ?
	WHERE id = ?
`);

const migrate = db.transaction((items) => {
	for (const row of items) {
		const path = perfScriptPath(row.run_id, row.step_id, row.mode);
		writeFileSync(join(process.cwd(), path), row.perf_script_output, 'utf8');
		update.run(path, row.id);
	}
});

migrate(rows);
db.exec('VACUUM');
db.close();

console.log(`Migrated ${rows.length} perf script output row(s) to ${perfScriptDir}.`);
