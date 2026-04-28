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
	// SQL statistics block
	sbReTPS          = regexp.MustCompile(`transactions:\s+\d+\s+\((\d+(?:\.\d+)?)\s+per sec\.\)`)
	sbReTxCount      = regexp.MustCompile(`transactions:\s+(\d+)\s+\(`)
	sbReQPS          = regexp.MustCompile(`queries:\s+\d+\s+\((\d+(?:\.\d+)?)\s+per sec\.\)`)
	sbReErrors       = regexp.MustCompile(`ignored errors:\s+(\d+)`)
	sbReReconnects   = regexp.MustCompile(`reconnects:\s+(\d+)`)
	sbReQueriesRead  = regexp.MustCompile(`\bread:\s+(\d+)`)
	sbReQueriesWrite = regexp.MustCompile(`\bwrite:\s+(\d+)`)
	sbReQueriesOther = regexp.MustCompile(`\bother:\s+(\d+)`)
	sbReQueriesTotal = regexp.MustCompile(`\btotal:\s+(\d+)`)
	// General statistics
	sbReTotalTime   = regexp.MustCompile(`total time:\s+([\d.]+)s`)
	sbReTotalEvents = regexp.MustCompile(`total number of events:\s+(\d+)`)
	// Latency block
	sbReLatMin = regexp.MustCompile(`\bmin:\s+([\d.]+)`)
	sbReLatAvg = regexp.MustCompile(`\bavg:\s+([\d.]+)`)
	sbReLatMax = regexp.MustCompile(`\bmax:\s+([\d.]+)`)
	sbReLatP95 = regexp.MustCompile(`95th percentile:\s+([\d.]+)`)
	// Custom Lua scripts that print their own rows/sec line
	sbReRowsPerSec = regexp.MustCompile(`rows/sec[^:]*:\s*([\d.]+)`)
	// Progress lines for thread count and fallback TPS/QPS
	sbReProgress = regexp.MustCompile(`\[\s*\d+s\s*\]\s+thds:\s+(\d+)\s+tps:\s+([\d.]+)\s+qps:\s+([\d.]+)`)
)

type sysbenchResult struct {
	TPS             float64
	QPS             float64
	LatencyAvgMs    float64
	LatencyMinMs    float64
	LatencyMaxMs    float64
	LatencyP95Ms    *float64
	TotalTimeSecs   float64
	TotalEvents     int64
	Transactions    int64
	Errors          int64
	Threads         int
	QueriesRead     int64
	QueriesWrite    int64
	QueriesOther    int64
	QueriesTotal    int64
	Reconnects      int64
	RowsPerSec      *float64
	Command         string
	LogPath         string
	ProcessedScript string
	SysbenchSummary *result.SysbenchSummary
	Perf            *result.PerfResult
}

func parseSysbenchFinalOutput(output string) *result.SysbenchSummary {
	var s result.SysbenchSummary

	if m := sbReTPS.FindStringSubmatch(output); m != nil {
		s.TPS, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := sbReTxCount.FindStringSubmatch(output); m != nil {
		s.Transactions, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReQPS.FindStringSubmatch(output); m != nil {
		s.QPS, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := sbReErrors.FindStringSubmatch(output); m != nil {
		s.Errors, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReReconnects.FindStringSubmatch(output); m != nil {
		s.Reconnects, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReQueriesRead.FindStringSubmatch(output); m != nil {
		s.QueriesRead, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReQueriesWrite.FindStringSubmatch(output); m != nil {
		s.QueriesWrite, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReQueriesOther.FindStringSubmatch(output); m != nil {
		s.QueriesOther, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReQueriesTotal.FindStringSubmatch(output); m != nil {
		s.QueriesTotal, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReTotalTime.FindStringSubmatch(output); m != nil {
		s.TotalTimeSecs, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := sbReTotalEvents.FindStringSubmatch(output); m != nil {
		s.TotalEvents, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := sbReLatMin.FindStringSubmatch(output); m != nil {
		s.LatencyMinMs, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := sbReLatAvg.FindStringSubmatch(output); m != nil {
		s.LatencyAvgMs, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := sbReLatMax.FindStringSubmatch(output); m != nil {
		s.LatencyMaxMs, _ = strconv.ParseFloat(m[1], 64)
	}
	if m := sbReLatP95.FindStringSubmatch(output); m != nil {
		v, _ := strconv.ParseFloat(m[1], 64)
		if v > 0 {
			s.LatencyP95Ms = &v
		}
	}
	if m := sbReRowsPerSec.FindStringSubmatch(output); m != nil {
		v, _ := strconv.ParseFloat(m[1], 64)
		s.RowsPerSec = &v
	}

	// Fallback: derive TPS/QPS/threads from progress lines when no SQL statistics block.
	progressMatches := sbReProgress.FindAllStringSubmatch(output, -1)
	if len(progressMatches) > 0 {
		// Use thread count from last progress line.
		last := progressMatches[len(progressMatches)-1]
		threads, _ := strconv.Atoi(last[1])
		s.Threads = threads

		if s.TPS == 0 {
			var sum float64
			for _, m := range progressMatches {
				v, _ := strconv.ParseFloat(m[2], 64)
				sum += v
			}
			s.TPS = sum / float64(len(progressMatches))
		}
		if s.QPS == 0 {
			var sum float64
			for _, m := range progressMatches {
				v, _ := strconv.ParseFloat(m[3], 64)
				sum += v
			}
			s.QPS = sum / float64(len(progressMatches))
		}
	}

	// Nothing useful parsed.
	if s.TPS == 0 && s.QPS == 0 && s.TotalEvents == 0 && s.RowsPerSec == nil {
		return nil
	}
	return &s
}

// runSysbenchStep executes a sysbench step: writes the Lua script, starts a
// snapshot ticker, spawns sysbench, parses output, then takes a final snapshot.
func runSysbenchStep(
	ctx context.Context,
	opts RunOpts,
	step plan.Step,
	pool *pgxpool.Pool,
	snapshots map[string][]result.SnapshotRow,
	intervalSecs int,
) (sysbenchResult, error) {
	server := opts.Plan.Server
	var res sysbenchResult

	// Write Lua script to a temp file.
	luaFile := fmt.Sprintf("%s/mybench-%s-%d.lua", opts.LogDir, opts.Timestamp, step.ID)
	script := plan.SubstituteParams(step.Script, opts.Plan.Params)
	if err := os.WriteFile(luaFile, []byte(script), 0644); err != nil {
		return sysbenchResult{}, fmt.Errorf("writing sysbench script: %w", err)
	}
	res.ProcessedScript = script

	// Build sysbench args.
	userOptions := strings.Fields(plan.SubstituteParams(step.PgbenchOptions, opts.Plan.Params))

	hasReportInterval := false
	for _, o := range userOptions {
		if strings.HasPrefix(o, "--report-interval") {
			hasReportInterval = true
			break
		}
	}

	args := []string{
		"--db-driver=pgsql",
		fmt.Sprintf("--pgsql-host=%s", server.Host),
		fmt.Sprintf("--pgsql-port=%d", server.Port),
		fmt.Sprintf("--pgsql-user=%s", server.Username),
		fmt.Sprintf("--pgsql-password=%s", server.Password),
		fmt.Sprintf("--pgsql-db=%s", server.Database),
	}
	args = append(args, userOptions...)
	if !hasReportInterval {
		args = append(args, "--report-interval=5")
	}
	args = append(args, luaFile, "run")

	res.Command = "sysbench " + strings.Join(args, " ")

	cmd := exec.CommandContext(ctx, "sysbench", args...)
	cmd.Env = os.Environ() // sysbench uses its own --pgsql-password flag, not PGPASSWORD

	// Set up log file.
	_, logFile, err := prepareStepFiles(opts.LogDir, opts.Timestamp, step.Name, "sysbench")
	res.LogPath = logFile
	if err != nil {
		return sysbenchResult{}, err
	}
	logFH, err := os.Create(logFile)
	if err != nil {
		return sysbenchResult{}, fmt.Errorf("creating log file: %w", err)
	}
	defer logFH.Close()

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return sysbenchResult{}, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return sysbenchResult{}, fmt.Errorf("stderr pipe: %w", err)
	}

	// Start snapshot ticker.
	ticker := NewSnapshotTicker(pool, opts.Plan.EnabledSnapTables, snapshots, intervalSecs, "bench")
	ticker.Start(ctx)
	perf, perfRes := maybeStartPerf(server, step, opts.Plan.Params, parseSysbenchDuration(userOptions))
	res.Perf = perfRes

	if err := cmd.Start(); err != nil {
		ticker.Stop()
		if perf != nil {
			res.Perf = perf.Stop(0)
		}
		return res, fmt.Errorf("starting sysbench: %w", err)
	}

	// Read stdout: tee to log and terminal, accumulate for parsing.
	stdoutDone := make(chan struct{})
	var stdoutBuilder strings.Builder
	go func() {
		defer close(stdoutDone)
		writers := []io.Writer{logFH}
		if opts.Progress {
			writers = append(writers, os.Stdout)
		}
		w := io.MultiWriter(writers...)
		scanner := bufio.NewScanner(stdoutPipe)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(w, line)
			stdoutBuilder.WriteString(line)
			stdoutBuilder.WriteByte('\n')
		}
	}()

	// Read stderr: tee to log and terminal.
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		writers := []io.Writer{logFH}
		if opts.Progress {
			writers = append(writers, os.Stderr)
		}
		w := io.MultiWriter(writers...)
		io.Copy(w, stderrPipe)
	}()

	<-stdoutDone
	<-stderrDone

	runErr := cmd.Wait()
	summary := parseSysbenchFinalOutput(stdoutBuilder.String())
	res.SysbenchSummary = summary
	if summary != nil {
		res.TPS = summary.TPS
		res.QPS = summary.QPS
		res.LatencyAvgMs = summary.LatencyAvgMs
		res.Transactions = summary.Transactions
	}
	if perf != nil {
		res.Perf = perf.Stop(res.Transactions)
	}

	// Stop ticker and take final snapshot.
	ticker.Stop()
	_ = collectOnce(ctx, pool, opts.Plan.EnabledSnapTables, "bench", snapshots)
	collectPgLocksOnce(ctx, pool, "bench", snapshots)

	if runErr != nil {
		return res, fmt.Errorf("sysbench exited with error: %w", runErr)
	}
	return res, nil
}
