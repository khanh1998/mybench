# mybench

`mybench` is a benchmark workbench for PostgreSQL schema and query design decisions.

It helps you answer questions like:

- "Which index strategy gives the best throughput for this workload?"
- "Does partitioning help enough to justify the extra complexity?"
- "What changed in locks, I/O, and table stats during this benchmark?"
- "How do the same benchmark steps behave across multiple parameter profiles?"

The app gives you a structured place to define benchmark plans, run them locally or on an EC2 runner, collect PostgreSQL statistics snapshots around the run, and compare results afterward.

## Who This Is For

`mybench` is aimed at people who need repeatable PostgreSQL experiments, especially:

- database engineers evaluating schema changes
- backend engineers tuning query-heavy code paths
- platform and SRE teams validating Postgres performance changes
- consultants or internal teams preparing evidence for a design decision

If you already use `pgbench`, SQL setup scripts, and `pg_stat_*` views, `mybench` gives you a UI and workflow around those tools instead of making you stitch everything together by hand.

## Core Idea

Instead of running one-off benchmark commands and pasting numbers into a doc, you organize work like this:

1. Create a **Decision**
2. Add one or more **Designs** you want to evaluate
3. Define the ordered **Steps** for each design
4. Run the design and collect benchmark + snapshot data
5. Compare runs or compare designs

That turns benchmark work from "one shell command I ran last week" into "an experiment I can revisit, replay, and explain."

## Concepts

### Decision

A decision is the question you are trying to answer.

Examples:

- "Best indexing strategy for `orders` lookup"
- "Should we move this workload to partitioned tables?"
- "Compare UUID vs bigint primary keys"

Each decision can contain multiple competing designs.

### Design

A design is one implementation approach for that decision.

Examples:

- "Current schema"
- "Add composite index on `(tenant_id, created_at)`"
- "Partition by month"

A design points at a PostgreSQL server + database and contains the benchmark plan you want to run.

### Step

A step is one ordered action in a design. Common step types are:

- `sql`: run SQL setup, seed, teardown, or validation statements
- `pgbench`: run workload scripts with `pgbench`
- `collect`: wait / collect around the benchmark window
- `pg_stat_statements_reset`: clear statement stats before the test
- `pg_stat_statements_collect`: capture statement stats after the test

This lets a benchmark look more like a full experiment than a single workload command.

### Run

A run is one execution of a design.

Each run stores:

- run status and timestamps
- top-level benchmark metrics like TPS and latency
- step output
- processed `pgbench` scripts and per-script metrics
- PostgreSQL snapshots collected before, during, and after the benchmark
- optional CloudWatch data for RDS/EC2 workflows

### Profile

A profile is a named set of parameter overrides for a design.

Use profiles when the same benchmark plan should run with different sizes or shapes of data, for example:

- `small`
- `medium`
- `large`
- `hot-cache`
- `cold-ish`

### Series

A series runs the same design multiple times across selected profiles in sequence. This is useful when you want a consistent batch of runs for comparison.

## How mybench Works

For each run, the app:

1. executes your setup and benchmark steps
2. collects PostgreSQL stats snapshots into a local SQLite database
3. stores step logs and parsed benchmark output
4. lets you inspect the run live through SSE
5. makes the resulting data queryable and comparable later

The app stores its own metadata and collected snapshots in SQLite at `data/mybench.db`.

Important design choice: the intended workflow is to benchmark against a fresh, isolated target database for a design so that snapshot deltas are easier to interpret.

## Local vs EC2 Runs

`mybench` supports two execution modes.

### Local runs

The web app runs benchmark steps from the machine hosting the app. This is the easiest way to get started.

Local runs use local PostgreSQL client tools such as:

- `psql`
- `pgbench`

Those binaries need to be installed and available on your `PATH`.

### EC2 runs

For heavier or more production-like execution, a design can run on a configured EC2 host.

In that mode:

- the UI exports a plan
- the remote host executes `mybench-runner`
- the result is imported back into the app

This is optional. New users should start with local runs first.

## Prerequisites

Before using `mybench`, make sure you have:

- Node.js and npm
- PostgreSQL client tools installed locally if you want local runs
- access to a PostgreSQL server you can benchmark safely

For EC2 mode you also need:

- an SSH-accessible EC2 instance
- the `mybench-runner` binary available on that instance
- an IAM instance profile with `CloudWatchReadOnlyAccess` if you want CloudWatch metrics

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the app

```bash
npm run dev
```

Open `http://localhost:5173`.

### 3. Add a PostgreSQL connection

Go to **Settings** and add a database server:

- name
- host / port
- username / password
- SSL if needed

Optional extras in Settings:

- RDS instance ID + AWS region for CloudWatch-backed telemetry
- SSH details if the PostgreSQL host should be inspected through SSH
- EC2 runner configuration for remote benchmark execution

Use the built-in connection tests before moving on.

### 4. Create your first decision

Create a decision that describes the question you want to answer, for example:

`Best indexing strategy for orders lookup`

### 5. Create a design

Add a design under that decision, choose the PostgreSQL server, and select the target database.

Each new design starts with a basic template of steps you can edit:

- setup SQL
- seed SQL
- post-seed SQL
- benchmark step
- optional teardown

### 6. Edit the benchmark plan

Typical workflow:

- write SQL to prepare schema and seed data
- define one or more `pgbench` scripts
- set `pgbench` options such as clients and duration
- add parameters if parts of the scripts should vary by profile
- enable the `pg_stat_*` tables you care about in Settings

### 7. Run it

Start a local run first.

Watch the live run page to see:

- step-by-step logs
- parsed `pgbench` metrics
- run phases
- telemetry and snapshot-backed charts

### 8. Compare results

Once you have multiple completed runs, use the compare pages to answer questions like:

- which run had the highest TPS?
- which design had lower latency?
- what changed in locks, table stats, or I/O counters?
- how did different profiles behave?

## A Good First Benchmark

If you are new to the app, keep the first experiment small:

1. Point at a non-production PostgreSQL database
2. Create one decision with two simple designs
3. Keep the setup SQL minimal
4. Use one `pgbench` script with a short duration like 30-60 seconds
5. Run each design at least twice
6. Compare the runs before adding more complexity

That gets you familiar with the workflow before you introduce profiles, series runs, EC2 execution, or lots of telemetry.

## Building the Optional EC2 Runner

The remote runner lives in `cli/` and builds to `bin/mybench-runner`.

```bash
cd cli
make build
```

After building, place `bin/mybench-runner` on the EC2 host inside the configured remote directory and make sure it is executable.

EC2 mode is best treated as a second step after the local workflow is already working.

## Development Commands

```bash
npm run dev
npm run build
npm run check
npm run preview
npm test
```

For the Go-based runner:

```bash
cd cli
make build
make test
make check
```

## Storage and Project Notes

- App data is stored in `data/mybench.db`
- PostgreSQL snapshots are copied into `snap_*` SQLite tables
- The app creates required SQLite tables at startup
- Completed runs remain queryable for compare pages and custom metrics

## Current Workflow Summary

If you only remember one thing, remember this:

1. configure a PostgreSQL server in Settings
2. create a decision
3. create one or more designs
4. define the benchmark steps
5. run the design
6. compare the results

That is the core loop `mybench` is built around.
