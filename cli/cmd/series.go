package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/khanh1998/mybench/cli/internal/pgconn"
	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
	"github.com/khanh1998/mybench/cli/internal/runner"
)

// emitSeriesEvent writes a __MB__-prefixed JSON event line to stdout and to execLog (if non-nil).
func emitSeriesEvent(jsonEvents bool, execLog *os.File, v any) {
	b, _ := json.Marshal(v)
	line := fmt.Sprintf("__MB__%s\n", b)
	if jsonEvents {
		fmt.Print(line)
		os.Stdout.Sync()
	}
	if execLog != nil {
		execLog.WriteString(line)
	}
}

// seriesLog writes a timestamped progress line to stdout and to execLog (if non-nil).
func seriesLog(execLog *os.File, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().UTC().Format(time.RFC3339)
	line := fmt.Sprintf("%s %s\n", ts, msg)
	fmt.Print(line)
	if execLog != nil {
		execLog.WriteString(line)
	}
}

// runSpec holds a parsed --run "plan.json,profileName,output.json" entry.
type runSpec struct {
	planPath    string
	profileName string
	outputFile  string
}

func parseRunSpec(raw string) (runSpec, error) {
	parts := strings.SplitN(raw, ",", 3)
	if len(parts) != 3 {
		return runSpec{}, fmt.Errorf("--run format must be \"plan.json,profileName,output.json\", got %q", raw)
	}
	return runSpec{
		planPath:    strings.TrimSpace(parts[0]),
		profileName: strings.TrimSpace(parts[1]),
		outputFile:  strings.TrimSpace(parts[2]),
	}, nil
}

func newSeriesCmd() *cobra.Command {
	var delaySecs int
	var runSpecs []string
	var logDir string
	var progress bool
	var logTailLines int
	var jsonEvents bool
	var execLogPath string

	cmd := &cobra.Command{
		Use:   "series",
		Short: "Run multiple benchmark plans sequentially with a delay between each",
		RunE: func(cmd *cobra.Command, args []string) error {
			var execLog *os.File
			if execLogPath != "" {
				var err error
				execLog, err = os.OpenFile(execLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
				if err != nil {
					fmt.Fprintf(os.Stderr, "warning: could not open exec log %q: %v\n", execLogPath, err)
				} else {
					defer execLog.Close()
				}
			}

			if len(runSpecs) == 0 {
				return fmt.Errorf("at least one --run spec is required")
			}

			// Parse all run specs upfront for early validation.
			specs := make([]runSpec, 0, len(runSpecs))
			for _, raw := range runSpecs {
				spec, err := parseRunSpec(raw)
				if err != nil {
					return err
				}
				specs = append(specs, spec)
			}

			// Ensure log dir exists.
			if err := os.MkdirAll(logDir, 0755); err != nil {
				return fmt.Errorf("creating log dir: %w", err)
			}

			// Top-level cancellable context — SIGINT cancels current run.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
			go func() {
				select {
				case sig := <-sigCh:
					fmt.Fprintf(os.Stderr, "\nReceived signal %s, cancelling...\n", sig)
					cancel()
				case <-ctx.Done():
				}
			}()

			anyFailed := false

			for i, spec := range specs {
				if ctx.Err() != nil {
					fmt.Fprintf(os.Stderr, "[series] Context cancelled, stopping after run %d\n", i)
					break
				}

				if i > 0 && delaySecs > 0 {
					seriesLog(execLog, "[series] Sleeping %ds before run %d/%d...", delaySecs, i+1, len(specs))
					emitSeriesEvent(jsonEvents, execLog, map[string]any{"event": "delay", "run_index": i, "seconds": delaySecs})
					select {
					case <-time.After(time.Duration(delaySecs) * time.Second):
					case <-ctx.Done():
						fmt.Fprintf(os.Stderr, "[series] Context cancelled during delay\n")
						break
					}
					if ctx.Err() != nil {
						break
					}
				}

				seriesLog(execLog, "[series] Run %d/%d — profile: %q", i+1, len(specs), spec.profileName)
				emitSeriesEvent(jsonEvents, execLog, map[string]any{"event": "run_start", "run_index": i, "profile": spec.profileName})

				// Load and configure plan.
				p, err := plan.ReadPlan(spec.planPath)
				if err != nil {
					fmt.Fprintf(os.Stderr, "[series] Run %d: error loading plan: %v\n", i+1, err)
					anyFailed = true
					// Write a minimal failed result so the importer can record the failure.
					failedResult := &result.Result{
						Version:       1,
						DesignID:      0,
						RunnerVersion: runner.RunnerVersion,
						Run: result.RunSummary{
							Status:     "failed",
							StartedAt:  time.Now().UTC().Format(time.RFC3339),
							FinishedAt: time.Now().UTC().Format(time.RFC3339),
							ProfileName: spec.profileName,
						},
						Snapshots: make(map[string][]result.SnapshotRow),
					}
					_ = result.WriteResult(spec.outputFile, failedResult)
					continue
				}

				if spec.profileName != "" {
					if err := plan.ApplyProfile(p, spec.profileName); err != nil {
						// Profile not found — log and continue; params stay at defaults.
						fmt.Fprintf(os.Stderr, "[series] Run %d: profile %q not found: %v\n", i+1, spec.profileName, err)
					}
				}

				// Ensure output dir exists.
				if err := os.MkdirAll(filepath.Dir(spec.outputFile), 0755); err != nil {
					return fmt.Errorf("creating output dir: %w", err)
				}

				timestamp := time.Now().UTC().Format("20060102T150405Z")
				opts := runner.RunOpts{
					Plan:         p,
					LogDir:       logDir,
					Progress:     progress,
					Timestamp:    timestamp,
					LogTailLines: logTailLines,
					JSONEvents:   jsonEvents,
					RunIndex:     i,
					ExecLog:      execLog,
				}

				pool, err := pgconn.NewPool(ctx,
					p.Server.Host, p.Server.Port,
					p.Server.Username, p.Server.Password, p.Server.Database, p.Server.SSL,
				)
				if err != nil {
					fmt.Fprintf(os.Stderr, "[series] Run %d: DB connection failed: %v\n", i+1, err)
					anyFailed = true
					failedResult := &result.Result{
						Version:       1,
						DesignID:      p.DesignID,
						RunnerVersion: runner.RunnerVersion,
						Run: result.RunSummary{
							Status:     "failed",
							StartedAt:  time.Now().UTC().Format(time.RFC3339),
							FinishedAt: time.Now().UTC().Format(time.RFC3339),
							ProfileName: p.ProfileName,
						},
						Snapshots: make(map[string][]result.SnapshotRow),
					}
					_ = result.WriteResult(spec.outputFile, failedResult)
					continue
				}

				res, runErr := runner.Run(ctx, opts, pool)
				pool.Close()

				if res == nil {
					res = &result.Result{
						Version:       1,
						DesignID:      p.DesignID,
						RunnerVersion: runner.RunnerVersion,
						Run: result.RunSummary{
							Status:     "failed",
							StartedAt:  time.Now().UTC().Format(time.RFC3339),
							FinishedAt: time.Now().UTC().Format(time.RFC3339),
							ProfileName: p.ProfileName,
						},
						Snapshots: make(map[string][]result.SnapshotRow),
					}
				}
				if runErr != nil {
					fmt.Fprintf(os.Stderr, "[series] Run %d failed: %v\n", i+1, runErr)
					anyFailed = true
				} else {
					fmt.Printf("[series] Run %d completed: TPS=%.2f\n", i+1, res.Run.TPS)
				}

				if wErr := result.WriteResult(spec.outputFile, res); wErr != nil {
					fmt.Fprintf(os.Stderr, "[series] Run %d: error writing result: %v\n", i+1, wErr)
				} else {
					fmt.Printf("[series] Result written to %s\n", spec.outputFile)
				}
			}

			signal.Stop(sigCh)
			cancel()

			emitSeriesEvent(jsonEvents, execLog, map[string]any{"event": "series_done"})
			if anyFailed {
				return fmt.Errorf("one or more runs in the series failed")
			}
			seriesLog(execLog, "[series] All %d runs completed.", len(specs))
			return nil
		},
	}

	cmd.Flags().IntVar(&delaySecs, "delay", 0, "seconds to wait between runs (default: 0)")
	cmd.Flags().StringArrayVar(&runSpecs, "run", nil, "\"plan.json,profileName,output.json\" (repeatable, ordered)")
	cmd.Flags().StringVar(&logDir, "log-dir", "/tmp", "directory for step log files")
	cmd.Flags().BoolVar(&progress, "progress", false, "tee subprocess output to terminal")
	cmd.Flags().IntVar(&logTailLines, "log-tail-lines", 100, "trailing log lines per step in result (0 to disable)")
	cmd.Flags().BoolVar(&jsonEvents, "json-events", false, "emit __MB__-prefixed JSON event lines to stdout for structured progress tracking")
	cmd.Flags().StringVar(&execLogPath, "exec-log", "", "path to write execution log (structured events + progress); written directly via file I/O")

	return cmd
}
