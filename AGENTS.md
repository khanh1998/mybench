# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server at localhost:5173
npm run build      # Production build
npm run check      # TypeScript + Svelte type check (run before committing)
npm run preview    # Preview production build
npm run test       # Run vitest unit tests
```

## Architecture

**mybench** is a SvelteKit app for comparing PostgreSQL table designs via pgbench/sysbench benchmarks. Runs execute on a remote VPS/EC2 instance via SSH using the Go CLI (`mybench-runner`).

### Core concepts

- **Decision** — a question being investigated (e.g. "which index strategy is faster?")
- **Design** — one candidate answer; has ordered **Steps** and optional **Params**
- **Profile** — a named set of param overrides for a design (e.g. "small", "large"); one profile produces one run
- **Series** — runs one design across multiple profiles sequentially (with optional delay between runs)
- **Suite** — runs multiple designs (each as a series) across a decision on a VPS runner

### Data flow

1. User creates a **Decision** → **Designs** (each with ordered **Steps** and optional **Params**)
2. **Run**: POST `/api/runs` with `ec2_server_id` → `startEc2Run()` generates `plan.json`, uploads to VPS via SSH, spawns `mybench-runner`, streams structured events back, imports results
3. **Series**: POST `/api/series` → `startSeries()` runs the design once per profile in order on VPS
4. **Suite**: POST `/api/suites` → `startSuite()` orchestrates multiple series across designs on VPS
5. Client navigates to the run/series/suite page → opens SSE stream at `/api/runs/[id]/stream` (or `/api/series/[id]/stream`, `/api/suites/[id]/stream`)
6. The Go CLI emits `__MB__`-prefixed JSON events (`step_start`, `step_done`, `phase`, `run_done`, etc.) which SvelteKit parses and forwards as SSE to the browser in real time
7. Snapshots stored in `snap_*` SQLite tables → queryable in the Compare page

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
- `pg-stats.ts` — `SNAP_TABLE_MAP`, `ALL_SNAP_TABLES` (used by plan-generator, MCP tools, snap-tables API)
- `run-manager.ts` — in-memory `Map<runId, ActiveRun>` holding `EventEmitter` + `currentPhase`; `createRun()`, `completeRun()`, `recoverStaleRuns()` called at startup

**Run execution (VPS/SSH only)**
- `ec2-executor.ts` — `startEc2Run()`: pre-creates per-step rows, generates plan, uploads via SSH, launches `mybench-runner` in background (`nohup ... &`) with `--exec-log`, tails exec log over SSH, reconnects SSH after tail, downloads result, imports
- `series-executor.ts` — `startSeries()`: requires `ec2_server_id`; pre-creates per-step rows for all runs, background-launches CLI, tails exec log, routes `__MB__` events by `run_index`
- `suite-executor.ts` — `startSuite()`: orchestrates multiple series across a decision on VPS; tails suite exec log, routes events via flat `run_index` map

**VPS / remote execution**
- `ec2-runner.ts` — SSH/SFTP utilities: `connectSsh()`, `exec()`, `execStreaming()`, `execStreamingCancellable()`, `uploadFile()`, `downloadFile()`, `shellQuote()`
- `plan-generator.ts` — `generatePlan()`: builds `plan.json` input for `mybench-runner` from a design + server config + param overrides
- `run-importer.ts` — parses `mybench-runner` JSON output and inserts snapshots + step results into local SQLite tables

**Supporting modules**
- `perf-inspect.ts` — detects Linux perf/cgroup support; returns `PerfScope`: `'postgres_cgroup'` | `'system'` | `'disabled'`
- `run-telemetry.ts` — collects Linux perf events during benchmarks (cgroup or system scope)
- `pg-stat-statements-schema.ts` — SQLite column type definitions for `snap_pg_stat_statements`
- `services/pg-servers.ts` / `services/ec2-servers.ts` — CRUD helpers for PG and VPS server records

**MCP integration (`mcp/`)**
- `server.ts`, `transport.ts`, `tools.ts` — MCP server exposing benchmark tools to Claude Code via `/routes/mcp/+server.ts`

### Key API endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/runs` | POST | Start a VPS run (`ec2_server_id` required) |
| `/api/runs/import` | POST | Import mybench-runner results |
| `/api/runs/[id]/stream` | GET | SSE stream for run progress |
| `/api/series` | POST | Start a series (design × profiles) on VPS |
| `/api/series/[id]/stream` | GET | SSE stream for series progress |
| `/api/suites` | POST | Start a suite (decision × designs × profiles) on VPS |
| `/api/suites/[id]/stream` | GET | SSE stream for suite progress |
| `/api/connections` | GET/POST | List/create PG server connections |
| `/api/ec2` | GET/POST | List/create VPS runner servers |
| `/api/query` | POST | Run custom SQL against SQLite snap_* tables |
| `/routes/mcp` | POST | MCP server endpoint |

### Key design decisions

- **Fresh DB per design**: each design uses its own isolated database, so `delta = bench_snapshot - pre_snapshot` gives clean benchmark numbers
- **`_phase` not `_is_baseline`**: snapshots carry `_phase ∈ {pre, bench, post}` to support pre/post collection windows, not just a boolean baseline flag
- **Enabled/disabled pg_stat tables**: stored in `pg_stat_table_selections` per server; version-incompatible tables auto-disabled on connect (`pg_stat_io` requires PG16+, etc.)
- **Step types**: `sql`, `pgbench`, `sysbench`, `collect`, `pg_stat_statements_reset`, `pg_stat_statements_collect`, `perf`
- **Param substitution**: `{{PARAM_NAME}}` in scripts/options is replaced at run time from the design's params or profile overrides
- **Custom metrics**: user writes SQL against `snap_*` tables using `?` as `_run_id` placeholder; executed via `POST /api/query` against SQLite
- **SSE replay**: if a run is already done when the client connects, stored stdout/stderr from `run_step_results` is replayed line-by-line
- **VPS workflow**: `plan.json` is generated locally → uploaded via SFTP → `mybench-runner --json-events --exec-log <path>` launched via `nohup ... &` → SvelteKit tails the exec log over SSH → results downloaded and imported via `run-importer.ts`
- **Exec log + tail-based SSE**: CLI writes `__MB__`-prefixed JSON events and timestamped human-readable progress lines to an exec log file (`--exec-log`, stored in `ec2_servers.log_dir` on VPS). SvelteKit tails this with `tail -n +1 -F` for refresh-safe streaming. Each invocation gets a session key `YYYYMMDDHHMMSS_TOKEN6` → `run_KEY.log` / `series_KEY.log` / `suite_KEY.log`. Debug log (stderr) goes to a separate `ec2_servers.cli_log_dir` directory.
- **SSH reconnect after tail**: After the exec log tail completes, a fresh SSH connection is opened before the result file check and download. Closing the tail channel from within `onData` can leave the ssh2 `Client` in a degraded state.
- **`exec_log_path` column**: `benchmark_runs`, `benchmark_series`, and `decision_suites` each store the VPS path of their exec log. SSE stream endpoints use this for tail-based streaming; falls back to in-memory EventEmitter if empty.
- **`output_file` on step results**: `run_step_results.output_file` stores the per-step pgbench/sysbench log path emitted in `step_start` events. Populated during live tail; overwritten (cleared) when `importResultIntoRun` re-inserts rows from the result JSON.
- **Structured events**: Go CLI emits `__MB__{json}` lines; SvelteKit strips them from stdout, routes by `run_index`, updates per-step DB rows live, and forwards as SSE `step`/`phase` events to the browser
- **`ec2_server_id` required**: all run/series/suite POST endpoints require a VPS runner — local execution path has been removed
- **MCP tool**: `run_design` tool calls `startEc2Run()` directly; `ec2_server_id` is required

### `enabled` field

Steps and table selections use `INTEGER` (0/1) for `enabled`, not boolean. In Svelte components, use `checked={!!step.enabled}` with `onchange` instead of `bind:checked`.

### CLI (`/cli/`)

Separate Go project (`mybench-runner`). Reads `plan.json`, executes steps (pgbench/sysbench/sql), collects pg_stat snapshots, writes results as JSON. Deployed to VPS for remote execution.

Key flags:
- `--json-events` — emit `__MB__{json}` structured event lines to stdout for real-time SSE feedback (used by all VPS runs)
- `--exec-log <path>` — write structured events + timestamped progress lines to a persistent log file on the VPS (safe across SIGKILL via direct `write()` syscalls); SvelteKit tails this file for refresh-safe SSE
- `--log-dir <path>` — directory for per-step pgbench/sysbench output files (paths included in `step_start` events as `output_file`)

Event types emitted: `step_start`, `step_done`, `phase`, `run_done` (from `runner.go`); `run_start`, `delay`, `series_done` (from `series.go`). All carry `run_index` so SvelteKit can route events to the correct run in a series/suite.
