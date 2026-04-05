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
	reTPS                   = regexp.MustCompile(`tps = (\d+\.\d+) \(without initial connection time\)`)
	reLatencyAvg            = regexp.MustCompile(`latency average = (\d+\.\d+) ms`)
	reLatencyStddev         = regexp.MustCompile(`latency stddev = (\d+\.\d+) ms`)
	reTransactions          = regexp.MustCompile(`number of transactions actually processed: (\d+)`)
	reFailedTransactions    = regexp.MustCompile(`number of failed transactions: (\d+)`)
	reTransactionType       = regexp.MustCompile(`transaction type:\s*([^\r\n]+)`)
	reScalingFactor         = regexp.MustCompile(`scaling factor:\s*(\d+)`)
	reQueryMode             = regexp.MustCompile(`query mode:\s*([^\r\n]+)`)
	reNumberOfClients       = regexp.MustCompile(`number of clients:\s*(\d+)`)
	reNumberOfThreads       = regexp.MustCompile(`number of threads:\s*(\d+)`)
	reMaximumTries          = regexp.MustCompile(`maximum number of tries:\s*(\d+)`)
	reDurationSecs          = regexp.MustCompile(`duration:\s*(\d+)\s*s`)
	reInitialConnectionTime = regexp.MustCompile(`initial connection time = (\d+\.\d+) ms`)
	reScriptTPS             = regexp.MustCompile(`tps = (\d+\.\d+)`)
	reScriptTransactions    = regexp.MustCompile(`-\s+(\d+)\s+transactions\b`)
	reScriptWeight          = regexp.MustCompile(`-\s+weight:\s*(\d+)`)
)

// pgbenchResult holds parsed metrics from pgbench stdout.
type pgbenchResult struct {
	TPS                     float64
	LatencyAvgMs            float64
	LatencyStddevMs         float64
	Transactions            int64
	FailedTransactions      int64
	TransactionType         *string
	ScalingFactor           *int
	QueryMode               *string
	NumberOfClients         *int
	NumberOfThreads         *int
	MaximumTries            *int
	DurationSecs            *int
	InitialConnectionTimeMs *float64
	Command                 string
	LogPath                 string
	ProcessedScript         string
	PgbenchSummary          *result.PgbenchSummary
	PgbenchScripts          []result.PgbenchScriptResult
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
	if m := reFailedTransactions.FindStringSubmatch(line); m != nil {
		res.FailedTransactions, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if m := reTransactionType.FindStringSubmatch(line); m != nil {
		res.TransactionType = stringPtr(strings.TrimSpace(m[1]))
	}
	if m := reScalingFactor.FindStringSubmatch(line); m != nil {
		res.ScalingFactor = intPtrFromString(m[1])
	}
	if m := reQueryMode.FindStringSubmatch(line); m != nil {
		res.QueryMode = stringPtr(strings.TrimSpace(m[1]))
	}
	if m := reNumberOfClients.FindStringSubmatch(line); m != nil {
		res.NumberOfClients = intPtrFromString(m[1])
	}
	if m := reNumberOfThreads.FindStringSubmatch(line); m != nil {
		res.NumberOfThreads = intPtrFromString(m[1])
	}
	if m := reMaximumTries.FindStringSubmatch(line); m != nil {
		res.MaximumTries = intPtrFromString(m[1])
	}
	if m := reDurationSecs.FindStringSubmatch(line); m != nil {
		res.DurationSecs = intPtrFromString(m[1])
	}
	if m := reInitialConnectionTime.FindStringSubmatch(line); m != nil {
		res.InitialConnectionTimeMs = float64PtrFromString(m[1])
	}
}

func stringPtr(value string) *string {
	return &value
}

func intPtrFromString(value string) *int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return nil
	}
	return &parsed
}

func float64PtrFromString(value string) *float64 {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return nil
	}
	return &parsed
}

func hasSummaryData(res *pgbenchResult) bool {
	return res.TPS != 0 ||
		res.LatencyAvgMs != 0 ||
		res.LatencyStddevMs != 0 ||
		res.Transactions != 0 ||
		res.FailedTransactions != 0 ||
		res.TransactionType != nil ||
		res.ScalingFactor != nil ||
		res.QueryMode != nil ||
		res.NumberOfClients != nil ||
		res.NumberOfThreads != nil ||
		res.MaximumTries != nil ||
		res.DurationSecs != nil ||
		res.InitialConnectionTimeMs != nil
}

func formatProcessedPgbenchScripts(scripts []plan.PgbenchScript) string {
	parts := make([]string, 0, len(scripts))
	for _, script := range scripts {
		parts = append(parts, fmt.Sprintf("-- [%s @%d]\n%s", script.Name, script.Weight, script.Script))
	}
	return strings.Join(parts, "\n\n")
}

func parsePgbenchFinalOutput(output string, scripts []plan.PgbenchScript) (*result.PgbenchSummary, []result.PgbenchScriptResult) {
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	summaryLines := make([]string, 0, len(lines))
	scriptBlocks := make([][]string, 0)
	currentScriptBlock := []string(nil)

	flushScriptBlock := func() {
		if len(currentScriptBlock) == 0 {
			return
		}
		scriptBlocks = append(scriptBlocks, currentScriptBlock)
		currentScriptBlock = nil
	}

	for _, line := range lines {
		if strings.HasPrefix(line, "SQL script ") {
			flushScriptBlock()
			currentScriptBlock = []string{line}
			continue
		}
		if currentScriptBlock != nil {
			currentScriptBlock = append(currentScriptBlock, line)
			continue
		}
		summaryLines = append(summaryLines, line)
	}
	flushScriptBlock()

	summaryProbe := &pgbenchResult{}
	parsePgbenchOutput(strings.Join(summaryLines, "\n"), summaryProbe)
	var summary *result.PgbenchSummary
	if hasSummaryData(summaryProbe) {
		summary = &result.PgbenchSummary{
			TPS:                     summaryProbe.TPS,
			LatencyAvgMs:            summaryProbe.LatencyAvgMs,
			LatencyStddevMs:         summaryProbe.LatencyStddevMs,
			Transactions:            summaryProbe.Transactions,
			FailedTransactions:      summaryProbe.FailedTransactions,
			TransactionType:         summaryProbe.TransactionType,
			ScalingFactor:           summaryProbe.ScalingFactor,
			QueryMode:               summaryProbe.QueryMode,
			NumberOfClients:         summaryProbe.NumberOfClients,
			NumberOfThreads:         summaryProbe.NumberOfThreads,
			MaximumTries:            summaryProbe.MaximumTries,
			DurationSecs:            summaryProbe.DurationSecs,
			InitialConnectionTimeMs: summaryProbe.InitialConnectionTimeMs,
		}
	}

	parsedScripts := make([]result.PgbenchScriptResult, 0, len(scriptBlocks))
	for idx, blockLines := range scriptBlocks {
		blockText := strings.Join(blockLines, "\n")
		blockProbe := &pgbenchResult{}
		parsePgbenchOutput(blockText, blockProbe)
		weight := 0
		if m := reScriptWeight.FindStringSubmatch(blockText); m != nil {
			weight, _ = strconv.Atoi(m[1])
		}
		if m := reScriptTransactions.FindStringSubmatch(blockText); m != nil {
			blockProbe.Transactions, _ = strconv.ParseInt(m[1], 10, 64)
		}
		if m := reScriptTPS.FindStringSubmatch(blockText); m != nil {
			blockProbe.TPS, _ = strconv.ParseFloat(m[1], 64)
		}

		name := fmt.Sprintf("Script %d", idx+1)
		scriptText := ""
		if idx < len(scripts) {
			name = scripts[idx].Name
			weight = scripts[idx].Weight
			scriptText = scripts[idx].Script
		}

		parsedScripts = append(parsedScripts, result.PgbenchScriptResult{
			Position:           idx,
			Name:               name,
			Weight:             weight,
			Script:             scriptText,
			TPS:                blockProbe.TPS,
			LatencyAvgMs:       blockProbe.LatencyAvgMs,
			LatencyStddevMs:    blockProbe.LatencyStddevMs,
			Transactions:       blockProbe.Transactions,
			FailedTransactions: blockProbe.FailedTransactions,
		})
	}

	return summary, parsedScripts
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
	var res pgbenchResult

	// Write each pgbench script to a temp file.
	scriptFiles := make([]string, 0, len(step.PgbenchScripts))
	resolvedScripts := make([]plan.PgbenchScript, 0, len(step.PgbenchScripts))
	for i, ps := range step.PgbenchScripts {
		// Resolve weight: use weight_expr expression if set, otherwise integer weight.
		resolvedWeight := ps.Weight
		if ps.WeightExpr != "" {
			substituted := strings.TrimSpace(plan.SubstituteParams(ps.WeightExpr, opts.Plan.Params))
			if w, err := strconv.Atoi(substituted); err == nil && w >= 0 {
				resolvedWeight = w
			}
		}
		if resolvedWeight <= 0 {
			continue // skip zero/negative weight scripts
		}
		fname := fmt.Sprintf("%s/mybench-%s-%d-%d.pgbench", opts.LogDir, opts.Timestamp, step.ID, i)
		script := plan.SubstituteParams(ps.Script, opts.Plan.Params)
		if err := os.WriteFile(fname, []byte(script), 0644); err != nil {
			return pgbenchResult{}, fmt.Errorf("writing pgbench script: %w", err)
		}
		scriptFiles = append(scriptFiles, fmt.Sprintf("%s@%d", fname, resolvedWeight))
		resolvedScripts = append(resolvedScripts, plan.PgbenchScript{
			ID:     ps.ID,
			Name:   ps.Name,
			Weight: resolvedWeight,
			Script: script,
		})
	}
	res.ProcessedScript = formatProcessedPgbenchScripts(resolvedScripts)

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
	var stdoutBuilder strings.Builder
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
			stdoutBuilder.WriteString(line)
			stdoutBuilder.WriteByte('\n')
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
	summary, parsedScripts := parsePgbenchFinalOutput(stdoutBuilder.String(), resolvedScripts)
	res.PgbenchSummary = summary
	res.PgbenchScripts = parsedScripts
	if summary != nil {
		res.TPS = summary.TPS
		res.LatencyAvgMs = summary.LatencyAvgMs
		res.LatencyStddevMs = summary.LatencyStddevMs
		res.Transactions = summary.Transactions
		res.FailedTransactions = summary.FailedTransactions
	}

	// Stop ticker and take final snapshot.
	ticker.Stop()
	_ = collectOnce(ctx, pool, opts.Plan.EnabledSnapTables, "bench", snapshots)
	collectPgLocksOnce(ctx, pool, "bench", snapshots)

	if runErr != nil {
		return res, fmt.Errorf("pgbench exited with error: %w", runErr)
	}
	return res, nil
}
