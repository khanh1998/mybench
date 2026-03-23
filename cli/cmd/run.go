package main

import (
	"context"
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

func newRunCmd() *cobra.Command {
	var outputFile string
	var paramOverrides []string
	var logDir string
	var progress bool

	cmd := &cobra.Command{
		Use:   "run <plan.json>",
		Short: "Execute a benchmark plan",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			planPath := args[0]

			// Parse plan.
			p, err := plan.ReadPlan(planPath)
			if err != nil {
				return fmt.Errorf("loading plan: %w", err)
			}

			// Apply --param overrides.
			overrides := make(map[string]string)
			for _, kv := range paramOverrides {
				parts := strings.SplitN(kv, "=", 2)
				if len(parts) != 2 {
					return fmt.Errorf("invalid --param format %q, expected KEY=VALUE", kv)
				}
				overrides[parts[0]] = parts[1]
			}
			plan.ApplyParamOverrides(p, overrides)

			// Determine output file name.
			if outputFile == "" {
				base := strings.TrimSuffix(filepath.Base(planPath), filepath.Ext(planPath))
				ts := time.Now().UTC().Format("20060102T150405Z")
				outputFile = fmt.Sprintf("%s-result-%s.json", base, ts)
			}

			// Ensure log dir exists.
			if err := os.MkdirAll(logDir, 0755); err != nil {
				return fmt.Errorf("creating log dir: %w", err)
			}

			timestamp := time.Now().UTC().Format("20060102T150405Z")

			opts := runner.RunOpts{
				Plan:      p,
				LogDir:    logDir,
				Progress:  progress,
				Timestamp: timestamp,
			}

			// Create a cancellable context so SIGINT can abort in-progress steps.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			// Create DB connection pool.
			pool, err := pgconn.NewPool(
				ctx,
				p.Server.Host,
				p.Server.Port,
				p.Server.Username,
				p.Server.Password,
				p.Server.Database,
				p.Server.SSL,
			)
			if err != nil {
				return fmt.Errorf("connecting to postgres: %w", err)
			}
			defer pool.Close()

			// Partial result for SIGINT handling.
			var partialResult *result.Result

			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

			go func() {
				select {
				case sig := <-sigCh:
					fmt.Fprintf(os.Stderr, "\nReceived signal %s, stopping...\n", sig)
					cancel()
					// Write partial result if we have one.
					if partialResult != nil {
						partialResult.Run.Status = "stopped"
						partialResult.Run.FinishedAt = time.Now().UTC().Format(time.RFC3339)
						if wErr := result.WriteResult(outputFile, partialResult); wErr != nil {
							fmt.Fprintf(os.Stderr, "error writing partial result: %v\n", wErr)
						} else {
							fmt.Fprintf(os.Stderr, "partial result written to %s\n", outputFile)
						}
					}
					os.Exit(1)
				case <-ctx.Done():
					// Normal completion; goroutine exits.
				}
			}()

			// Run the benchmark.
			// We set up a minimal partial result upfront so SIGINT can write it.
			partialResult = &result.Result{
				Version:       1,
				DesignID:      p.DesignID,
				RunnerVersion: runner.RunnerVersion,
				Run: result.RunSummary{
					Status:                  "running",
					StartedAt:               time.Now().UTC().Format(time.RFC3339),
					SnapshotIntervalSeconds: p.RunSettings.SnapshotIntervalSeconds,
					PreCollectSecs:          p.RunSettings.PreCollectSecs,
					PostCollectSecs:         p.RunSettings.PostCollectSecs,
				},
				Snapshots: make(map[string][]result.SnapshotRow),
			}

			res, err := runner.Run(ctx, opts, pool)
			// Update partial result pointer so SIGINT writes the most recent state.
			if res != nil {
				partialResult = res
			}

			// Stop signal handler goroutine.
			signal.Stop(sigCh)
			cancel()

			if err != nil {
				// Write partial/failed result to disk.
				if res != nil {
					if wErr := result.WriteResult(outputFile, res); wErr != nil {
						fmt.Fprintf(os.Stderr, "error writing result: %v\n", wErr)
					} else {
						fmt.Fprintf(os.Stderr, "result written to %s\n", outputFile)
					}
				}
				return err
			}

			// Write final result.
			if err := result.WriteResult(outputFile, res); err != nil {
				return fmt.Errorf("writing result: %w", err)
			}

			fmt.Printf("Result written to %s\n", outputFile)
			return nil
		},
	}

	cmd.Flags().StringVarP(&outputFile, "output", "o", "", "output result file (default: <plan-basename>-result-<timestamp>.json)")
	cmd.Flags().StringArrayVar(&paramOverrides, "param", nil, "override plan param KEY=VALUE (repeatable)")
	cmd.Flags().StringVar(&logDir, "log-dir", "/tmp", "directory for step log files")
	cmd.Flags().BoolVar(&progress, "progress", false, "tee subprocess output to terminal")

	return cmd
}
