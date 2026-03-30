# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server at localhost:5173
npm run build      # Production build
npm run check      # TypeScript + Svelte type check (run before committing)
npm run preview    # Preview production build
```

## Architecture

**mybench** is a SvelteKit app for comparing PostgreSQL table designs via pgbench benchmarks.

### Data flow
1. User creates a **Decision** → **Designs** (each with ordered **Steps**)
2. Clicking "Run" POSTs to `/api/runs` → inserts a `benchmark_runs` row → runs steps async → returns `{ run_id }` immediately
3. Client navigates to `/designs/[id]/runs/[runId]` → opens SSE stream at `/api/runs/[id]/stream`
4. For pgbench steps: baseline snapshot → spawn pgbench → periodic pg_stat_* snapshots → final snapshot
5. Snapshots stored in `snap_*` SQLite tables → queryable in the Compare page

### Storage
- **SQLite** (`data/mybench.db`) via `better-sqlite3` (sync API, no ORM)
- All tables — including all 21 `snap_*` tables — are created at startup in `src/lib/server/db.ts` via `CREATE TABLE IF NOT EXISTS`
- `snap_*` tables have `_id, _run_id, _collected_at, _is_baseline` prepended to all PG columns
- PG→SQLite type mapping: `oid/integer/bigint/boolean → INTEGER`, `double precision/numeric → REAL`, everything else → `TEXT`

### Server modules (`src/lib/server/`)
- `db.ts` — SQLite singleton + all migrations + seed data (global saved queries)
- `pg-client.ts` — `createPool()`, `testConnection()`, `discoverPgStatTables()`
- `pg-stats.ts` — `collectSnapshot()` (queries PG, inserts into snap_ tables), `SNAP_TABLE_MAP` (pg view name → snap table name), `getEnabledTablesForRun()`
- `pgbench.ts` — `runPgbench()` (spawns child process, streams output via EventEmitter), `runSqlStep()` (executes SQL statements via pg pool)
- `run-manager.ts` — in-memory `Map<runId, ActiveRun>` holding EventEmitter + ChildProcess + pg.Pool + snapshot timer; `recoverStaleRuns()` called at startup

### Key design decisions
- **Fresh DB per design**: each design uses its own isolated database, so `delta = final_snapshot - baseline_snapshot` gives clean benchmark numbers
- **Enabled/disabled pg_stat tables**: stored in `pg_stat_table_selections` per server; version-incompatible tables auto-disabled on connect (`pg_stat_io` requires PG16+, etc.)
- **Step types**: `sql` (executed via `pool.query()`, split on `;`) or `pgbench` (spawned as child process with script written to `/tmp/mybench-{runId}-{stepId}.pgbench`)
- **Custom metrics**: user writes SQL against `snap_*` tables using `?` as `_run_id` placeholder; executed via `POST /api/query` against SQLite
- **SSE replay**: if a run is already done when the client connects, stored stdout/stderr from `run_step_results` is replayed line-by-line

### `enabled` field
Steps and table selections use `INTEGER` (0/1) for `enabled`, not boolean. In Svelte components, use `checked={!!step.enabled}` with `onchange` instead of `bind:checked`.
