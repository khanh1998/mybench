# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server at localhost:5173
npm run build      # Production build
npm run check      # TypeScript + Svelte type check (run before committing)
npm run preview    # Preview production build
npm run test       # Run vitest unit tests
```

## Architecture

**mybench** is a SvelteKit app for comparing PostgreSQL table designs via pgbench/sysbench benchmarks. Runs can execute locally or on a remote EC2 instance via SSH.

### Core concepts

- **Decision** — a question being investigated (e.g. "which index strategy is faster?")
- **Design** — one candidate answer; has ordered **Steps** and optional **Params**
- **Profile** — a named set of param overrides for a design (e.g. "small", "large"); one profile produces one run
- **Series** — runs one design across multiple profiles sequentially (with optional delay between runs)
- **Suite** — runs multiple designs (each as a series) across a decision; can run locally or on EC2

### Data flow

1. User creates a **Decision** → **Designs** (each with ordered **Steps** and optional **Params**)
2. **Local run**: POST `/api/runs` → inserts `benchmark_runs` row → `startRun()` in `run-executor.ts` runs steps async → returns `{ run_id }` immediately
3. **EC2 run**: POST `/api/runs` with `ec2_server_id` → `startEc2Run()` generates `plan.json`, uploads to EC2, spawns `mybench-runner`, polls for completion, imports results
4. **Series**: POST `/api/series` → `startSeries()` runs the design once per profile in order
5. **Suite**: POST `/api/suites` → `startSuite()` orchestrates multiple series across designs
6. Client navigates to the run/series/suite page → opens SSE stream at `/api/runs/[id]/stream` (or `/api/series/[id]/stream`, `/api/suites/[id]/stream`)
7. For bench steps: pre-collect phase → spawn pgbench/sysbench → periodic pg_stat_* snapshots → post-collect phase
8. Snapshots stored in `snap_*` SQLite tables → queryable in the Compare page

### Storage

- **SQLite** (`data/mybench.db`) via `better-sqlite3` (sync API, no ORM)
- All tables — including all 21+ `snap_*` tables — are created at startup in `src/lib/server/db.ts` via `CREATE TABLE IF NOT EXISTS`
- `snap_*` tables have `_id, _run_id, _collected_at, _phase` prepended to all PG columns
  - `_phase TEXT` values: `'pre'` | `'bench'` | `'post'` (snapshot phase, not a boolean baseline flag)
  - `delta = bench_snapshot - pre_snapshot` gives clean benchmark numbers
- PG→SQLite type mapping: `oid/integer/bigint/boolean → INTEGER`, `double precision/numeric → REAL`, everything else → `TEXT`

### Server modules (`src/lib/server/`)

**Core infrastructure**
- `db.ts` — SQLite singleton + all migrations + seed data (global saved queries)
- `pg-client.ts` — `createPool()`, `testConnection()`, `discoverPgStatTables()`
- `pg-stats.ts` — `collectSnapshot()` (queries PG, inserts into snap_ tables), `SNAP_TABLE_MAP`, `getEnabledTablesForRun()`
- `run-manager.ts` — in-memory `Map<runId, ActiveRun>` holding EventEmitter + ChildProcess + pg.Pool + snapshot timer + `currentPhase`; `recoverStaleRuns()` called at startup

**Run execution**
- `run-executor.ts` — `startRun()`: creates `benchmark_runs` row, resolves server/params, runs steps async locally; shared by HTTP API and MCP tool
- `ec2-executor.ts` — `startEc2Run()`: generates plan, uploads via SSH, spawns `mybench-runner`, polls EC2 for completion, imports results
- `series-executor.ts` — `startSeries()`: runs one design with multiple profiles sequentially with delay; emits SSE progress events
- `suite-executor.ts` — `startSuite()`: orchestrates multiple series across a decision; local or EC2

**Step executors (`step-executors/`)**
- `index.ts` — `getStepExecutor()` router; `BENCH_STEP_TYPES = ['pgbench', 'sysbench']`
- `pgbench-executor.ts` — spawns pgbench, writes script to `/tmp/mybench-{runId}-{stepId}.pgbench`
- `sysbench-executor.ts` — spawns sysbench OLTP benchmarks
- `sql-executor.ts` — executes SQL statements via `pool.query()`, split on `;`
- `collect-executor.ts` — collects pg_stat snapshots for a fixed duration
- `pg-stat-executor.ts` — `pg_stat_statements_reset` and `pg_stat_statements_collect` step types

**EC2 / remote execution**
- `ec2-runner.ts` — SSH/SFTP utilities: `connectSsh()`, `exec()`, `execStreaming()`, `uploadFile()`, `downloadFile()`, `shellQuote()`
- `plan-generator.ts` — `generatePlan()`: builds `plan.json` input for `mybench-runner` from a design + server config + param overrides
- `run-importer.ts` — parses `mybench-runner` JSON output and inserts snapshots + step results into local SQLite tables

**Supporting modules**
- `params.ts` — `substituteParams()`: replaces `{{PARAM_NAME}}` placeholders in scripts and pgbench_options
- `pgbench.ts` / `sysbench.ts` — low-level process spawn helpers
- `perf-inspect.ts` — detects Linux perf/cgroup support; returns `PerfScope`: `'postgres_cgroup'` | `'system'` | `'disabled'`
- `run-telemetry.ts` — collects Linux perf events during benchmarks (cgroup or system scope)
- `pg-stat-statements-schema.ts` — SQLite column type definitions for `snap_pg_stat_statements`
- `services/pg-servers.ts` / `services/ec2-servers.ts` — CRUD helpers for PG and EC2 server records

**MCP integration (`mcp/`)**
- `server.ts`, `transport.ts`, `tools.ts` — MCP server exposing benchmark tools to Claude Code via `/routes/mcp/+server.ts`

### Key API endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/runs` | POST | Start a local or EC2 run |
| `/api/runs/import` | POST | Import mybench-runner results |
| `/api/runs/[id]/stream` | GET | SSE stream for run progress |
| `/api/series` | POST | Start a series (design × profiles) |
| `/api/series/[id]/stream` | GET | SSE stream for series progress |
| `/api/suites` | POST | Start a suite (decision × designs × profiles) |
| `/api/suites/[id]/stream` | GET | SSE stream for suite progress |
| `/api/connections` | GET/POST | List/create PG server connections |
| `/api/ec2` | GET/POST | List/create EC2 servers |
| `/api/query` | POST | Run custom SQL against SQLite snap_* tables |
| `/routes/mcp` | POST | MCP server endpoint |

### Key design decisions

- **Fresh DB per design**: each design uses its own isolated database, so `delta = bench_snapshot - pre_snapshot` gives clean benchmark numbers
- **`_phase` not `_is_baseline`**: snapshots carry `_phase ∈ {pre, bench, post}` to support pre/post collection windows, not just a boolean baseline flag
- **Enabled/disabled pg_stat tables**: stored in `pg_stat_table_selections` per server; version-incompatible tables auto-disabled on connect (`pg_stat_io` requires PG16+, etc.)
- **Step types**: `sql`, `pgbench`, `sysbench`, `collect`, `pg_stat_statements_reset`, `pg_stat_statements_collect`
- **Param substitution**: `{{PARAM_NAME}}` in scripts/options is replaced at run time from the design's params or profile overrides
- **Custom metrics**: user writes SQL against `snap_*` tables using `?` as `_run_id` placeholder; executed via `POST /api/query` against SQLite
- **SSE replay**: if a run is already done when the client connects, stored stdout/stderr from `run_step_results` is replayed line-by-line
- **EC2 workflow**: `plan.json` is generated locally → uploaded via SFTP → `mybench-runner` (Go CLI in `/cli/`) executes it → results downloaded and imported via `run-importer.ts`
- **MCP tool**: `startRun()` in `run-executor.ts` is shared between the HTTP API and the MCP tool to avoid duplication

### `enabled` field

Steps and table selections use `INTEGER` (0/1) for `enabled`, not boolean. In Svelte components, use `checked={!!step.enabled}` with `onchange` instead of `bind:checked`.

### CLI (`/cli/`)

Separate Go project (`mybench-runner`). Reads `plan.json`, executes steps (pgbench/sysbench/sql), collects pg_stat snapshots, writes results as JSON. Deployed to EC2 for remote execution.
