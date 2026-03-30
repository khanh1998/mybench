package runner

import (
	"context"
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
	Timestamp    string // formatted timestamp used in file names
	LogTailLines int    // trailing log lines per step to embed in result (0 = skip)
}

// Run executes all enabled steps in the plan in order and returns a Result.
// The caller is responsible for writing the result to disk (including on SIGINT).
func Run(ctx context.Context, opts RunOpts, pool *pgxpool.Pool) (*result.Result, error) {
	var runParams []result.RunParam
	for _, p := range opts.Plan.Params {
		runParams = append(runParams, result.RunParam{Name: p.Name, Value: p.Value})
	}

	res := &result.Result{
		Version:       1,
		DesignID:      opts.Plan.DesignID,
		RunnerVersion: RunnerVersion,
		Run: result.RunSummary{
			Status:                  "running",
			StartedAt:               time.Now().UTC().Format(time.RFC3339),
			SnapshotIntervalSeconds: opts.Plan.RunSettings.SnapshotIntervalSeconds,
			PreCollectSecs:          opts.Plan.RunSettings.PreCollectSecs,
			PostCollectSecs:         opts.Plan.RunSettings.PostCollectSecs,
			ProfileName:             opts.Plan.ProfileName,
			Params:                  runParams,
		},
		Snapshots: make(map[string][]result.SnapshotRow),
	}

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

	seenPgbench := false

	for _, step := range steps {
		// Determine phase.
		var phase string
		switch {
		case !seenPgbench:
			phase = "pre"
		case seenPgbench && step.Type != "pgbench":
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

		switch step.Type {
		case "sql":
			script := plan.SubstituteParams(step.Script, opts.Plan.Params)
			if opts.Progress {
				fmt.Printf("[sql] %s\n", step.Name)
			}
			var logPath string
			stepRes.Command, logPath, stepErr = runSQLStep(opts, step.Name, script, step.NoTransaction)
			stepRes.Log = tailFile(logPath, opts.LogTailLines)
			if stepErr != nil {
				stepRes.Status = "failed"
				stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
				res.Steps = append(res.Steps, stepRes)
				res.Run.Status = "failed"
				res.Run.FinishedAt = stepRes.FinishedAt
				return res, fmt.Errorf("sql step %q: %w", step.Name, stepErr)
			}

		case "collect":
			if opts.Progress {
				fmt.Printf("[collect] %s (phase=%s, duration=%ds)\n", step.Name, phase, step.DurationSecs)
			}
			stepRes.Command = fmt.Sprintf("collect phase=%s duration=%ds interval=%ds", phase, step.DurationSecs, opts.Plan.RunSettings.SnapshotIntervalSeconds)
			if err := runCollectStep(ctx, opts, step, pool, res.Snapshots, phase); err != nil {
				// Collect errors are non-fatal (warn and continue).
				fmt.Fprintf(os.Stderr, "warning: collect step %q: %v\n", step.Name, err)
			}

		case "pg_stat_statements_reset":
			if opts.Progress {
				fmt.Printf("[pg_stat_statements reset] %s\n", step.Name)
			}
			stepRes.Command = "pg_stat_statements_reset()"
			msg, err := runPgStatStatementsResetStep(ctx, opts, pool)
			if err != nil {
				stepRes.Log = err.Error()
				fmt.Fprintf(os.Stderr, "warning: pg_stat_statements reset step %q: %v\n", step.Name, err)
			} else {
				stepRes.Log = msg
			}

		case "pg_stat_statements_collect":
			if opts.Progress {
				fmt.Printf("[pg_stat_statements collect] %s\n", step.Name)
			}
			stepRes.Command = fmt.Sprintf("collect pg_stat_statements for database=%s", opts.Plan.Server.Database)
			msg, err := runPgStatStatementsCollectStep(ctx, opts, step, pool, res.Snapshots)
			if err != nil {
				stepRes.Log = err.Error()
				fmt.Fprintf(os.Stderr, "warning: pg_stat_statements collect step %q: %v\n", step.Name, err)
			} else {
				stepRes.Log = msg
			}

		case "pgbench":
			if opts.Progress {
				fmt.Printf("[pgbench] %s\n", step.Name)
			}
			res.Run.BenchStartedAt = time.Now().UTC().Format(time.RFC3339)
			pbRes, err := runPgbenchStep(ctx, opts, step, pool, res.Snapshots, opts.Plan.RunSettings.SnapshotIntervalSeconds)
			seenPgbench = true
			stepRes.Command = pbRes.Command
			stepRes.Log = tailFile(pbRes.LogPath, opts.LogTailLines)

			// Capture metrics even on error (partial results).
			res.Run.TPS = pbRes.TPS
			res.Run.LatencyAvgMs = pbRes.LatencyAvgMs
			res.Run.LatencyStddevMs = pbRes.LatencyStddevMs
			res.Run.Transactions = pbRes.Transactions

			if err != nil {
				stepErr = err
				stepRes.Status = "failed"
				stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
				res.Steps = append(res.Steps, stepRes)
				res.Run.Status = "failed"
				res.Run.FinishedAt = stepRes.FinishedAt
				return res, fmt.Errorf("pgbench step %q: %w", step.Name, err)
			}

		default:
			fmt.Fprintf(os.Stderr, "warning: unknown step type %q for step %q, skipping\n", step.Type, step.Name)
		}

		stepRes.Status = "completed"
		stepRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		res.Steps = append(res.Steps, stepRes)

		// Update phase for next step if we just ran pgbench.
		if step.Type == "pgbench" {
			seenPgbench = true
		}

		// Track post phase start time.
		if seenPgbench && step.Type != "pgbench" && res.Run.PostStartedAt == "" {
			res.Run.PostStartedAt = time.Now().UTC().Format(time.RFC3339)
		}
	}

	res.Run.Status = "completed"
	res.Run.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	return res, nil
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
		collectPgLocksOnce(ctx, pool, phase, snapshots)

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
