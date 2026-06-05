---
name: project-backlog
description: Upcoming features, known gaps, and completed work for mybench
metadata:
  type: project
---

## Upcoming / backlog

- **Dynamic proc collection script**: Currently the SSH collection script in `host_metrics.go` always runs in full (all `/proc` files read in one round trip), and group filtering happens on the Go parsing side. Enhancement: generate the collection script dynamically based on `ProcStep.Groups` so deselected groups are not read at all — reduces SSH payload and remote CPU on the database host. Relevant file: `cli/internal/runner/host_metrics.go` (`collectionScript` const and `collectOnce()`).
- **Fly.io runner support**: alternative to EC2 for VPS runners
- **MCP compare tool**: expose comparison queries via MCP
- **`--log-tail-lines` truncation bug**: known truncation in Go CLI exec log tail
- **Run locking / lock starvation fix**: prevent concurrent runs from colliding
- **SSH pg_servers**: SSH tunneling for PG server connections

## Done

- proc step (opt-in host metrics, configurable groups + interval)
- perf step (Linux perf stat/record/trace)
- pg_stat step (interval-based postgres stats collection)
- Series runs (design × profiles on VPS)
- Suite runs (decision × designs × profiles on VPS)
- Parameterized weights in pgbench scripts
- Lock tree analysis in UI
- WAL checkpoint on exit + faster SQLite pragmas
- Host metrics t=0 snapshot aligned to bench start
