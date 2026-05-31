package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
)

const RunnerVersion = "0.1.0"

// RunOpts holds runtime options for the runner.
type RunOpts struct {
	Plan         *plan.Plan
	LogDir       string
	Progress     bool
	Timestamp    string   // formatted timestamp used in file names
	LogTailLines int      // trailing log lines per step to embed in result (0 = skip)
	JSONEvents   bool     // emit __MB__-prefixed JSON event lines to stdout
	RunIndex     int      // 0 for standalone runs; index within a series
	ExecLog      *os.File // exec log file for structured events + progress (written via file I/O)
}

// emitEvent writes a __MB__-prefixed JSON line to stdout (if JSONEvents) and to ExecLog (if set).
func (opts *RunOpts) emitEvent(v any) {
	b, _ := json.Marshal(v)
	line := fmt.Sprintf("__MB__%s\n", b)
	if opts.JSONEvents {
		fmt.Print(line)
		os.Stdout.Sync()
	}
	if opts.ExecLog != nil {
		opts.ExecLog.WriteString(line)
	}
}

// logInfo writes a timestamped progress line to ExecLog (and stdout if Progress is set).
func (opts *RunOpts) logInfo(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().UTC().Format(time.RFC3339)
	line := fmt.Sprintf("%s %s\n", ts, msg)
	if opts.Progress {
		fmt.Print(line)
	}
	if opts.ExecLog != nil {
		opts.ExecLog.WriteString(line)
	}
}

// Run executes all enabled steps in the plan in order and returns a Result.
// The caller is responsible for writing the result to disk (including on SIGINT).
func Run(ctx context.Context, opts RunOpts, pool *pgxpool.Pool) (*result.Result, error) {
	var runParams []result.RunParam
	for _, p := range opts.Plan.Params {
		runParams = append(runParams, result.RunParam{Name: p.Name, Value: p.Value})
	}

	runStartTime := time.Now().UTC()
	res := &result.Result{
		Version:       1,
		DesignID:      opts.Plan.DesignID,
		RunnerVersion: RunnerVersion,
		Run: result.RunSummary{
			Status:                  "running",
			StartedAt:               runStartTime.Format(time.RFC3339),
			SnapshotIntervalSeconds: opts.Plan.RunSettings.SnapshotIntervalSeconds,
			PreCollectSecs:          opts.Plan.RunSettings.PreCollectSecs,
			PostCollectSecs:         opts.Plan.RunSettings.PostCollectSecs,
			ProfileName:             opts.Plan.ProfileName,
			Params:                  runParams,
		},
		Snapshots: make(map[string][]result.SnapshotRow),
	}

	// Prepare host metrics collector (SSH connect) but don't start ticking yet.
	// Start() is called just before the bench step so ticks align with bench start.
	hostCollector := NewHostMetricsCollector(opts.Plan.Server, opts.Plan.RunSettings.SnapshotIntervalSeconds)

	// Sort enabled steps by position.
	steps := make([]plan.Step, 0, len(opts.Plan.Steps))
	for _, s := range opts.Plan.Steps {
		if s.Enabled {
			steps = append(steps, s)
		}
	}
	sort.Slice(steps, func(i, j int) bool {
		return steps[i].Position < steps[j].Position
	})

	// Emit run_done on all return paths (deferred so it captures the final status).
	defer func() {
		opts.emitEvent(map[string]any{"event": "run_done", "run_index": opts.RunIndex, "status": res.Run.Status})
	}()

	var pendingPerfs []pendingPerfCollect
	defer func() {
		if res.Run.Status == "failed" {
			cleanupPendingPerfs(pendingPerfs)
		}
	}()

	seenPgbench := false
	var benchStartTime, benchEndTime time.Time
	var lastPhase string // tracks the last emitted phase for transition events

	for _, step := range steps {
		// Determine phase.
		isBenchStep := step.Type == "pgbench" || step.Type == "sysbench"
		var phase string
		switch {
		case !seenPgbench:
			phase = "pre"
		case seenPgbench && !isBenchStep:
			phase = "post"
		default:
			phase = "bench"
		}

		stepRes := result.StepResult{
			StepID:    step.ID,
			Position:  step.Position,
			Name:      step.Name,
			Type:      step.Type,
			StartedAt: time.Now().UTC().Format(time.RFC3339),
		}

		var stepErr error

		// Emit phase transition events when the phase changes.
		if phase != lastPhase {
			switch {
			case lastPhase == "" && phase == "pre":
				opts.emitEvent(map[string]any{"event": "phase", "run_index": opts.RunIndex, "name": "pre", "status": "running", "duration_secs": opts.Plan.RunSettings.PreCollectSecs})
			case lastPhase == "pre" && phase != "pre":
				opts.emitEvent(map[string]any{"event": "phase", "run_index": opts.RunIndex, "name": "pre", "status": "completed"})
				if phase == "post" {
					opts.emitEvent(map[string]any{"event": "phase", "run_index": opts.RunIndex, "name": "post", "status": "running", "duration_secs": opts.Plan.RunSettings.PostCollectSecs})
				}
			case lastPhase == "bench" && phase == "post":
				opts.emitEvent(map[string]any{"event": "phase", "run_index": opts.RunIndex, "name": "post", "status": "running", "duration_secs": opts.Plan.RunSettings.PostCollectSecs})
			}
			lastPhase = phase
		}

		// Compute the step output log path (used by pgbench/sysbench/sql steps).
		stepLogPath := filepath.Join(opts.LogDir, fmt.Sprintf("mybench-%s-%s.log", opts.Timestamp, sanitizeName(step.Name)))

		// Emit step_start event; include output_file path for step types that produce one.
		stepStartEvt := map[string]any{"event": "step_start", "run_index": opts.RunIndex, "step_id": step.ID, "position": step.Position, "name": step.Name, "type": step.Type}
		if step.Type == "pgbench" || step.Type == "sysbench" || step.Type == "sql" {
			stepStartEvt["output_file"] = stepLogPath
		}
		opts.emitEvent(stepStartEvt)
		opts.logInfo("[step %d] %q (%s) starting", step.Position, step.Name, step.Type)

		switch step.Type {
		case "sql":
			script := plan.SubstituteParams(step.Script, opts.Plan.Params)
			var logPath string
			stepRes.Command, logPath, stepErr = runSQLStep(opts, step.Name, script, step.NoTransaction)
			stepRes.Log = tailFile(logPath, opts.LogTailLines)
			if stepErr != nil {
				stepRes.Status = "failed"
				stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
				opts.emitEvent(map[string]any{"event": "step_done", "run_index": opts.RunIndex, "step_id": step.ID, "status": "failed", "exit_code": 1})
				res.Steps = append(res.Steps, stepRes)
				res.Run.Status = "failed"
				res.Run.FinishedAt = stepRes.FinishedAt
				return res, fmt.Errorf("sql step %q: %w", step.Name, stepErr)
			}

		case "collect":
			opts.logInfo("[collect] %s (phase=%s, duration=%ds)", step.Name, phase, step.DurationSecs)
			stepRes.Command = fmt.Sprintf("collect phase=%s duration=%ds interval=%ds", phase, step.DurationSecs, opts.Plan.RunSettings.SnapshotIntervalSeconds)
			if err := runCollectStep(ctx, opts, step, pool, res.Snapshots, phase); err != nil {
				// Collect errors are non-fatal (warn and continue).
				fmt.Fprintf(os.Stderr, "warning: collect step %q: %v\n", step.Name, err)
			}

		case "pg_stat_statements_reset":
			opts.logInfo("[pg_stat_statements reset] %s", step.Name)
			stepRes.Command = "pg_stat_statements_reset()"
			msg, err := runPgStatStatementsResetStep(ctx, opts, pool)
			if err != nil {
				stepRes.Log = err.Error()
				fmt.Fprintf(os.Stderr, "warning: pg_stat_statements reset step %q: %v\n", step.Name, err)
			} else {
				stepRes.Log = msg
			}

		case "pg_stat_statements_collect":
			opts.logInfo("[pg_stat_statements collect] %s", step.Name)
			stepRes.Command = fmt.Sprintf("collect pg_stat_statements for database=%s", opts.Plan.Server.Database)
			msg, err := runPgStatStatementsCollectStep(ctx, opts, step, pool, res.Snapshots)
			if err != nil {
				stepRes.Log = err.Error()
				fmt.Fprintf(os.Stderr, "warning: pg_stat_statements collect step %q: %v\n", step.Name, err)
			} else {
				stepRes.Log = msg
			}

		case "pg_stat":
			opts.logInfo("[pg_stat] %s (instant)", step.Name)
			var pgStatLog string
			if opts.Plan.PgStatStep != nil {
				cfg := opts.Plan.PgStatStep
				if cfg.ResetStats {
					if _, err := pool.Exec(ctx, "SELECT pg_stat_reset()"); err != nil {
						fmt.Fprintf(os.Stderr, "warning: pg_stat_reset(): %v\n", err)
					} else {
						pgStatLog += "pg_stat_reset() OK\n"
					}
				}
				if cfg.ResetStatements {
					msg, err := runPgStatStatementsResetStep(ctx, opts, pool)
					if err != nil {
						fmt.Fprintf(os.Stderr, "warning: pg_stat_statements_reset: %v\n", err)
					} else {
						pgStatLog += msg + "\n"
					}
				}
			}
			stepRes.Command = "pg_stat"
			stepRes.Log = strings.TrimSpace(pgStatLog)

		case "perf":
			modes := enabledPerfModes(step)
			opts.logInfo("[perf %s] %s (non-blocking)", strings.Join(modes, ","), step.Name)
			pending, err := firePerfStep(step, opts, &stepRes)
			if err != nil {
				stepErr = err
				stepRes.Status = "failed"
				stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
				opts.emitEvent(map[string]any{"event": "step_done", "run_index": opts.RunIndex, "step_id": step.ID, "status": "failed", "exit_code": 1})
				res.Steps = append(res.Steps, stepRes)
				res.Run.Status = "failed"
				res.Run.FinishedAt = stepRes.FinishedAt
				return res, fmt.Errorf("perf step %q: %w", step.Name, err)
			}
			for _, perfRes := range stepRes.Perfs {
				if perfRes == nil {
					continue
				}
				if stepRes.Command == "" {
					stepRes.Command = perfRes.Command
				} else if perfRes.Command != "" {
					stepRes.Command += "\n" + perfRes.Command
				}
				stepRes.Log = strings.TrimSpace(stepRes.Log + "\n" + perfRes.RawOutput)
				if perfRes.RawError != "" {
					stepRes.Log = strings.TrimSpace(stepRes.Log + "\n" + perfRes.RawError)
				}
			}
			for i := range pending {
				if pending[i].perfRes != nil && pending[i].perfRes.Status == "running" {
					pending[i].stepIdx = len(res.Steps)
					pendingPerfs = append(pendingPerfs, pending[i])
				}
			}

		case "pgbench":
			opts.logInfo("[pgbench] %s", step.Name)
			benchStartTime = time.Now().UTC()
			res.Run.BenchStartedAt = benchStartTime.Format(time.RFC3339)
			if hostCollector != nil {
				hostCollector.Start()
			}
			snapTables, pgLocksEnabled, pgLocksIntervalSecs, snapIntervalSecs := resolvePgStatConfig(opts)
			pbRes, err := runPgbenchStep(ctx, opts, step, pool, res.Snapshots, snapIntervalSecs, snapTables, pgLocksEnabled, pgLocksIntervalSecs)
			benchEndTime = time.Now().UTC()
			seenPgbench = true
			stepRes.Command = pbRes.Command
			stepRes.Log = tailFile(pbRes.LogPath, opts.LogTailLines)
			stepRes.ProcessedScript = pbRes.ProcessedScript
			if pbRes.PgbenchSummary != nil {
				stepRes.PgbenchSummary = pbRes.PgbenchSummary
			}
			if len(pbRes.PgbenchScripts) > 0 {
				stepRes.PgbenchScripts = pbRes.PgbenchScripts
			}
			if pbRes.Perf != nil {
				stepRes.Perfs = append(stepRes.Perfs, pbRes.Perf)
			}

			// Capture metrics even on error (partial results).
			res.Run.TPS = pbRes.TPS
			res.Run.LatencyAvgMs = pbRes.LatencyAvgMs
			res.Run.LatencyStddevMs = pbRes.LatencyStddevMs
			res.Run.Transactions = pbRes.Transactions

			if err != nil {
				stepErr = err
				stepRes.Status = "failed"
				stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
				opts.emitEvent(map[string]any{"event": "step_done", "run_index": opts.RunIndex, "step_id": step.ID, "status": "failed", "exit_code": 1})
				res.Steps = append(res.Steps, stepRes)
				res.Run.Status = "failed"
				res.Run.FinishedAt = stepRes.FinishedAt
				return res, fmt.Errorf("pgbench step %q: %w", step.Name, err)
			}

		case "sysbench":
			opts.logInfo("[sysbench] %s", step.Name)
			benchStartTime = time.Now().UTC()
			res.Run.BenchStartedAt = benchStartTime.Format(time.RFC3339)
			if hostCollector != nil {
				hostCollector.Start()
			}
			snapTables, pgLocksEnabled, pgLocksIntervalSecs, snapIntervalSecs := resolvePgStatConfig(opts)
			sbRes, err := runSysbenchStep(ctx, opts, step, pool, res.Snapshots, snapIntervalSecs, snapTables, pgLocksEnabled, pgLocksIntervalSecs)
			benchEndTime = time.Now().UTC()
			seenPgbench = true
			stepRes.Command = sbRes.Command
			stepRes.Log = tailFile(sbRes.LogPath, opts.LogTailLines)
			stepRes.ProcessedScript = sbRes.ProcessedScript
			if sbRes.SysbenchSummary != nil {
				stepRes.SysbenchSummary = sbRes.SysbenchSummary
			}
			if sbRes.Perf != nil {
				stepRes.Perfs = append(stepRes.Perfs, sbRes.Perf)
			}

			// Capture top-level metrics even on error (partial results).
			res.Run.TPS = sbRes.TPS
			res.Run.LatencyAvgMs = sbRes.LatencyAvgMs
			res.Run.Transactions = sbRes.Transactions

			if err != nil {
				stepErr = err
				stepRes.Status = "failed"
				stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
				opts.emitEvent(map[string]any{"event": "step_done", "run_index": opts.RunIndex, "step_id": step.ID, "status": "failed", "exit_code": 1})
				res.Steps = append(res.Steps, stepRes)
				res.Run.Status = "failed"
				res.Run.FinishedAt = stepRes.FinishedAt
				return res, fmt.Errorf("sysbench step %q: %w", step.Name, err)
			}

		default:
			fmt.Fprintf(os.Stderr, "warning: unknown step type %q for step %q, skipping\n", step.Type, step.Name)
		}

		stepRes.Status = "completed"
		stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		opts.emitEvent(map[string]any{"event": "step_done", "run_index": opts.RunIndex, "step_id": step.ID, "status": "completed", "exit_code": 0})
		opts.logInfo("[step %d] %q done", step.Position, step.Name)
		res.Steps = append(res.Steps, stepRes)

		// Update phase for next step if we just ran a bench step.
		if isBenchStep {
			seenPgbench = true
		}

		// Track post phase start time.
		if seenPgbench && !isBenchStep && res.Run.PostStartedAt == "" {
			res.Run.PostStartedAt = time.Now().UTC().Format(time.RFC3339)
		}
	}

	// Emit final phase completion event.
	switch lastPhase {
	case "pre":
		opts.emitEvent(map[string]any{"event": "phase", "run_index": opts.RunIndex, "name": "pre", "status": "completed"})
	case "post":
		opts.emitEvent(map[string]any{"event": "phase", "run_index": opts.RunIndex, "name": "post", "status": "completed"})
	}

	// Collect any non-blocking perf steps after normal workload steps complete.
	for i := range pendingPerfs {
		collectPendingPerf(&pendingPerfs[i])
		idx := pendingPerfs[i].stepIdx
		if idx >= 0 && idx < len(res.Steps) {
			if pendingPerfs[i].perfRes != nil {
				if len(res.Steps[idx].Perfs) == 0 {
					res.Steps[idx].Perfs = append(res.Steps[idx].Perfs, pendingPerfs[i].perfRes)
				}
				if res.Steps[idx].Command == "" {
					res.Steps[idx].Command = pendingPerfs[i].perfRes.Command
				} else if pendingPerfs[i].perfRes.Command != "" && !strings.Contains(res.Steps[idx].Command, pendingPerfs[i].perfRes.Command) {
					res.Steps[idx].Command += "\n" + pendingPerfs[i].perfRes.Command
				}
				res.Steps[idx].Log = strings.TrimSpace(res.Steps[idx].Log + "\n" + pendingPerfs[i].perfRes.RawOutput)
				if pendingPerfs[i].perfRes.RawError != "" {
					res.Steps[idx].Log = strings.TrimSpace(res.Steps[idx].Log + "\n" + pendingPerfs[i].perfRes.RawError)
				}
			}
		}
	}

	// Stop host metrics collection and store results.
	if hostCollector != nil {
		snaps, cfg := hostCollector.Stop()
		if len(snaps) > 0 {
			res.HostSnapshots = snaps
		}
		if len(cfg) > 0 {
			res.HostConfig = cfg
		}
	}

	_ = benchEndTime

	res.Run.Status = "completed"
	res.Run.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	return res, nil
}

// resolvePgStatConfig returns the snap tables, pg_locks config, and interval to use for
// pgbench/sysbench steps. When a pg_stat step is present its config takes precedence;
// otherwise falls back to the plan-level enabled_snap_tables for backward compatibility.
func resolvePgStatConfig(opts RunOpts) (snapTables []plan.SnapTableSpec, pgLocksEnabled bool, pgLocksIntervalSecs int, snapIntervalSecs int) {
	if opts.Plan.PgStatStep != nil {
		cfg := opts.Plan.PgStatStep
		return cfg.SnapTables, cfg.PgLocksEnabled, cfg.PgLocksIntervalSeconds, cfg.IntervalSeconds
	}
	// Backward compat: no pg_stat step → use plan-level tables, no pg_locks, default interval
	return opts.Plan.EnabledSnapTables, false, 0, opts.Plan.RunSettings.SnapshotIntervalSeconds
}

// tailFile reads the last n lines from path. Best-effort: returns "" on any error.
func tailFile(path string, n int) string {
	if n <= 0 || path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// runCollectStep runs a collect step: loops collecting snapshots for DurationSecs.
func runCollectStep(
	ctx context.Context,
	opts RunOpts,
	step plan.Step,
	pool *pgxpool.Pool,
	snapshots map[string][]result.SnapshotRow,
	phase string,
) error {
	intervalSecs := opts.Plan.RunSettings.SnapshotIntervalSeconds
	if intervalSecs <= 0 {
		intervalSecs = 10
	}
	durationSecs := step.DurationSecs
	if durationSecs <= 0 {
		// Fall back to plan-level setting based on phase.
		if phase == "pre" {
			durationSecs = opts.Plan.RunSettings.PreCollectSecs
		} else {
			durationSecs = opts.Plan.RunSettings.PostCollectSecs
		}
	}

	deadline := time.Now().Add(time.Duration(durationSecs) * time.Second)
	interval := time.Duration(intervalSecs) * time.Second

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if err := collectOnce(ctx, pool, opts.Plan.EnabledSnapTables, phase, snapshots); err != nil {
			return err
		}
		collectPgLocksOnce(ctx, pool, phase, snapshots, false) // legacy collect step never collects pg_locks

		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		sleep := interval
		if sleep > remaining {
			sleep = remaining
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(sleep):
		}
	}
	return nil
}

// prepareStepFiles returns paths for the script and log files for a step.
func prepareStepFiles(logDir, timestamp, stepName, ext string) (scriptPath, logPath string, err error) {
	safe := sanitizeName(stepName)
	scriptPath = filepath.Join(logDir, fmt.Sprintf("mybench-%s-%s.%s", timestamp, safe, ext))
	logPath = filepath.Join(logDir, fmt.Sprintf("mybench-%s-%s.log", timestamp, safe))
	return scriptPath, logPath, nil
}

// sanitizeName replaces characters unsafe for filenames with underscores.
func sanitizeName(name string) string {
	replacer := strings.NewReplacer(
		" ", "_",
		"/", "_",
		"\\", "_",
		":", "_",
		"*", "_",
		"?", "_",
		"\"", "_",
		"<", "_",
		">", "_",
		"|", "_",
	)
	return replacer.Replace(name)
}
