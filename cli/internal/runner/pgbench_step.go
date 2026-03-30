package runner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
)

var (
	reTPS          = regexp.MustCompile(`tps = (\d+\.\d+) \(without initial connection time\)`)
	reLatencyAvg   = regexp.MustCompile(`latency average = (\d+\.\d+) ms`)
	reLatencyStddev = regexp.MustCompile(`latency stddev = (\d+\.\d+) ms`)
	reTransactions = regexp.MustCompile(`number of transactions actually processed: (\d+)`)
)

// pgbenchResult holds parsed metrics from pgbench stdout.
type pgbenchResult struct {
	TPS             float64
	LatencyAvgMs    float64
	LatencyStddevMs float64
	Transactions    int64
	Command         string
	LogPath         string
}

// parsePgbenchOutput scans pgbench stdout lines and extracts metrics.
func parsePgbenchOutput(line string, res *pgbenchResult) {
	if m := reTPS.FindStringSubmatch(line); m != nil {
		res.TPS, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := reLatencyAvg.FindStringSubmatch(line); m != nil {
		res.LatencyAvgMs, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := reLatencyStddev.FindStringSubmatch(line); m != nil {
		res.LatencyStddevMs, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := reTransactions.FindStringSubmatch(line); m != nil {
		res.Transactions, _ = strconv.ParseInt(m[1], 10, 64)
	}
}

// runPgbenchStep executes a pgbench step: writes scripts, starts snapshot ticker,
// spawns pgbench, parses output, then takes a final snapshot.
func runPgbenchStep(
	ctx context.Context,
	opts RunOpts,
	step plan.Step,
	pool *pgxpool.Pool,
	snapshots map[string][]result.SnapshotRow,
	intervalSecs int,
) (pgbenchResult, error) {
	server := opts.Plan.Server

	// Write each pgbench script to a temp file.
	scriptFiles := make([]string, 0, len(step.PgbenchScripts))
	for i, ps := range step.PgbenchScripts {
		fname := fmt.Sprintf("%s/mybench-%s-%d-%d.pgbench", opts.LogDir, opts.Timestamp, step.ID, i)
		script := plan.SubstituteParams(ps.Script, opts.Plan.Params)
		if err := os.WriteFile(fname, []byte(script), 0644); err != nil {
			return pgbenchResult{}, fmt.Errorf("writing pgbench script: %w", err)
		}
		scriptFiles = append(scriptFiles, fmt.Sprintf("%s@%d", fname, ps.Weight))
	}

	// Parse and build pgbench args.
	baseArgs := strings.Fields(plan.SubstituteParams(step.PgbenchOptions, opts.Plan.Params))
	args := append(baseArgs,
		"-h", server.Host,
		"-p", fmt.Sprintf("%d", server.Port),
		"-U", server.Username,
		server.Database,
	)
	for _, sf := range scriptFiles {
		args = append(args, "-f", sf)
	}

	var res pgbenchResult
	res.Command = "pgbench " + strings.Join(args, " ")

	cmd := exec.CommandContext(ctx, "pgbench", args...)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+server.Password)

	// Set up log file.
	_, logFile, err := prepareStepFiles(opts.LogDir, opts.Timestamp, step.Name, "pgbench")
	res.LogPath = logFile
	if err != nil {
		return pgbenchResult{}, err
	}
	logFH, err := os.Create(logFile)
	if err != nil {
		return pgbenchResult{}, fmt.Errorf("creating log file: %w", err)
	}
	defer logFH.Close()

	// Pipe stdout so we can parse metrics and also log.
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return pgbenchResult{}, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return pgbenchResult{}, fmt.Errorf("stderr pipe: %w", err)
	}

	// Start snapshot ticker.
	ticker := NewSnapshotTicker(pool, opts.Plan.EnabledSnapTables, snapshots, intervalSecs, "bench")
	ticker.Start(ctx)

	if err := cmd.Start(); err != nil {
		ticker.Stop()
		return res, fmt.Errorf("starting pgbench: %w", err)
	}

	// Read stdout in a goroutine, parsing metrics as we go.
	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		var writers []io.Writer
		writers = append(writers, logFH)
		if opts.Progress {
			writers = append(writers, os.Stdout)
		}
		w := io.MultiWriter(writers...)
		scanner := bufio.NewScanner(stdoutPipe)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(w, line)
			parsePgbenchOutput(line, &res)
		}
	}()

	// Read stderr in a goroutine.
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		var writers []io.Writer
		writers = append(writers, logFH)
		if opts.Progress {
			writers = append(writers, os.Stderr)
		}
		w := io.MultiWriter(writers...)
		io.Copy(w, stderrPipe)
	}()

	<-stdoutDone
	<-stderrDone

	runErr := cmd.Wait()

	// Stop ticker and take final snapshot.
	ticker.Stop()
	_ = collectOnce(ctx, pool, opts.Plan.EnabledSnapTables, "bench", snapshots)
	collectPgLocksOnce(ctx, pool, "bench", snapshots)

	if runErr != nil {
		return res, fmt.Errorf("pgbench exited with error: %w", runErr)
	}
	return res, nil
}
