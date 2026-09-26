package runner

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
	"golang.org/x/crypto/ssh"
)

type pendingPerfCollect struct {
	stepIdx  int
	basePath string
	mode     string
	step     plan.Step
	srv      plan.ServerConfig
	fireTime time.Time
	delay    int
	duration int
	perfRes  *result.PerfResult
}

func runPerfStep(step plan.Step, opts RunOpts, res *result.StepResult) error {
	pending, err := firePerfStep(step, opts, res)
	if err != nil {
		return err
	}
	for i := range pending {
		collectPendingPerf(&pending[i])
	}
	return nil
}

func enabledPerfModes(step plan.Step) []string {
	var modes []string
	if step.PerfStatEnabled {
		modes = append(modes, "stat")
	}
	if step.PerfRecordEnabled {
		modes = append(modes, "record")
	}
	if step.PerfTraceEnabled {
		modes = append(modes, "trace")
	}
	if step.PerfC2cEnabled {
		modes = append(modes, "c2c")
	}
	if len(modes) == 0 {
		if mode := strings.TrimSpace(step.PerfMode); mode != "" {
			return []string{mode}
		}
	}
	return modes
}

func firePerfStep(step plan.Step, opts RunOpts, res *result.StepResult) ([]pendingPerfCollect, error) {
	modes := enabledPerfModes(step)
	pending := make([]pendingPerfCollect, 0, len(modes))
	for _, mode := range modes {
		p := firePerfMode(step, opts, mode)
		pending = append(pending, p)
		if p.perfRes != nil {
			res.Perfs = append(res.Perfs, p.perfRes)
		}
	}
	return pending, nil
}

func firePerfMode(step plan.Step, opts RunOpts, mode string) pendingPerfCollect {
	perfRes, durationSecs, ok := preparePerfStep(mode, step, opts)
	if !ok {
		return pendingPerfCollect{mode: mode, step: step, srv: opts.Plan.Server, perfRes: perfRes}
	}
	delaySecs, warning := resolvePerfDelayForMode(step, mode, opts.Plan.Params)
	if warning != "" {
		perfRes.Warnings = append(perfRes.Warnings, warning)
	}

	var perfCmd string
	var err error
	token := fmt.Sprintf("mybench-perf-%s-%d", mode, time.Now().UnixNano())
	basePath := "/tmp/" + token
	switch mode {
	case "stat":
		perfCmd, err = buildPerfStatCmd(step, opts, durationSecs, perfRes)
	case "record":
		perfCmd, err = buildPerfRecordCmd(step, opts, durationSecs, basePath, perfRes)
	case "trace":
		perfCmd, err = buildPerfTraceCmd(step, opts, durationSecs)
	case "c2c":
		perfCmd, err = buildPerfC2cCmd(step, opts, durationSecs, basePath, perfRes)
	default:
		perfRes.Warnings = append(perfRes.Warnings, fmt.Sprintf("unknown perf mode %q", mode))
		perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return pendingPerfCollect{mode: mode, step: step, srv: opts.Plan.Server, perfRes: perfRes}
	}
	if err != nil {
		perfRes.Warnings = append(perfRes.Warnings, err.Error())
		perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return pendingPerfCollect{mode: mode, step: step, srv: opts.Plan.Server, perfRes: perfRes}
	}
	if delaySecs > 0 {
		perfCmd = "bash -c " + shellQuote(fmt.Sprintf("sleep %d && exec %s", delaySecs, perfCmd))
	}
	perfRes.Command = perfCmd
	if out, err := startDetachedPerfCommand(opts.Plan.Server, basePath, perfCmd); err != nil {
		perfRes.RawError = out
		perfRes.Warnings = append(perfRes.Warnings, fmt.Sprintf("start perf %s: %v", mode, err))
		perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return pendingPerfCollect{mode: mode, step: step, srv: opts.Plan.Server, perfRes: perfRes}
	}
	perfRes.Status = "running"
	return pendingPerfCollect{
		basePath: basePath,
		mode:     mode,
		step:     step,
		srv:      opts.Plan.Server,
		fireTime: time.Now(),
		delay:    delaySecs,
		duration: durationSecs,
		perfRes:  perfRes,
	}
}

func collectPendingPerf(p *pendingPerfCollect) {
	if p == nil || p.perfRes == nil || p.basePath == "" || p.perfRes.Status != "running" {
		return
	}
	needed := time.Duration(p.delay+p.duration+2) * time.Second
	if remaining := needed - time.Since(p.fireTime); remaining > 0 {
		time.Sleep(remaining)
	}
	switch p.mode {
	case "stat":
		collectPerfStat(p)
	case "record":
		collectPerfRecord(p)
	case "trace":
		collectPerfTrace(p)
	case "c2c":
		collectPerfC2c(p)
	default:
		p.perfRes.Status = "unavailable"
		p.perfRes.Warnings = append(p.perfRes.Warnings, fmt.Sprintf("unknown perf mode %q", p.mode))
		p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	}
}

func buildPerfStatCmd(step plan.Step, opts RunOpts, durationSecs int, perfRes *result.PerfResult) (string, error) {
	events := strings.TrimSpace(plan.SubstituteParams(step.PerfEvents, opts.Plan.Params))
	if events == "" {
		events = opts.Plan.Server.PerfEvents
	}
	if strings.TrimSpace(events) == "" {
		events = defaultPerfEvents
	}
	args := []string{"sudo", "env", "LC_ALL=C", "perf", "stat", "-x", "'\\t'", "-a"}
	// -e must come before -G (perf requires events defined before cgroups)
	args = append(args, "-e", shellQuote(events))
	if cg := resolvePerfCgroup(step, opts); cg != "" {
		args = append(args, "-G", shellQuote(cg))
	}
	repeat := strings.TrimSpace(plan.SubstituteParams(step.PerfRepeat, opts.Plan.Params))
	if repeat != "" {
		if n, err := strconv.Atoi(repeat); err == nil && n > 0 {
			args = append(args, "-r", strconv.Itoa(n))
		} else {
			perfRes.Warnings = append(perfRes.Warnings, fmt.Sprintf("perf repeat %q did not resolve to a positive number; omitting -r", step.PerfRepeat))
		}
	}
	args = append(args, "--", "sleep", strconv.Itoa(durationSecs))
	return strings.Join(args, " "), nil
}

func buildPerfRecordCmd(step plan.Step, opts RunOpts, durationSecs int, basePath string, perfRes *result.PerfResult) (string, error) {
	freq := strings.TrimSpace(plan.SubstituteParams(step.PerfFreq, opts.Plan.Params))
	if freq == "" {
		freq = "99"
	}
	if n, err := strconv.Atoi(freq); err != nil || n <= 0 {
		perfRes.Warnings = append(perfRes.Warnings, fmt.Sprintf("perf frequency %q did not resolve to a positive number; using 99", step.PerfFreq))
		freq = "99"
	}
	callGraph := strings.TrimSpace(step.PerfCallGraph)
	if callGraph == "" {
		callGraph = "dwarf"
	}
	if callGraph != "dwarf" && callGraph != "fp" && callGraph != "lbr" {
		perfRes.Warnings = append(perfRes.Warnings, fmt.Sprintf("unknown call graph %q; using dwarf", callGraph))
		callGraph = "dwarf"
	}

	mmapPages := strings.TrimSpace(plan.SubstituteParams(step.PerfMmapPages, opts.Plan.Params))
	if mmapPages == "" {
		mmapPages = "4096"
	}
	dataPath := basePath + ".data"
	args := []string{"sudo", "perf", "record", "-F", freq, "--call-graph", shellQuote(callGraph), "-m", mmapPages, "-a"}
	if cg := resolvePerfCgroup(step, opts); cg != "" {
		// -e must come before -G (perf requires events defined before cgroups)
		args = append(args, "-e", "cpu-clock", "-G", shellQuote(cg))
	}
	args = append(args, "-o", shellQuote(dataPath), "--", "sleep", strconv.Itoa(durationSecs))
	return strings.Join(args, " "), nil
}

func buildPerfTraceCmd(step plan.Step, opts RunOpts, durationSecs int) (string, error) {
	mmapPages := strings.TrimSpace(plan.SubstituteParams(step.PerfMmapPages, opts.Plan.Params))
	if mmapPages == "" {
		mmapPages = "4096"
	}
	timeoutSecs := durationSecs + 2
	args := []string{fmt.Sprintf("sudo timeout %d", timeoutSecs), "perf", "trace", "--summary", "-m", mmapPages, "-a"}
	if cg := resolvePerfCgroup(step, opts); cg != "" {
		args = append(args, "-G", shellQuote(cg))
	}
	args = append(args, "--", fmt.Sprintf("sleep %d", durationSecs))
	return strings.Join(args, " "), nil
}

func resolvePerfCgroup(step plan.Step, opts RunOpts) string {
	if c := strings.TrimSpace(plan.SubstituteParams(step.PerfCgroup, opts.Plan.Params)); c != "" {
		return c
	}
	if opts.Plan.Server.PerfScope == "postgres_cgroup" && opts.Plan.Server.PerfCgroup != "" {
		return opts.Plan.Server.PerfCgroup
	}
	return ""
}

func collectPerfStat(p *pendingPerfCollect) {
	out, errOut, warnings := collectDetachedPerfFiles(p.srv, p.basePath, true)
	p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	p.perfRes.RawOutput = out
	p.perfRes.RawError = errOut
	p.perfRes.Warnings = append(p.perfRes.Warnings, warnings...)
	p.perfRes.Events, warnings = parsePerfStatOutput(errOut, 0)
	p.perfRes.Warnings = append(p.perfRes.Warnings, warnings...)
	if len(p.perfRes.Events) > 0 {
		p.perfRes.Status = "completed"
	} else {
		p.perfRes.Status = "unavailable"
	}
}

func collectPerfRecord(p *pendingPerfCollect) {
	client, err := newPerfSSHClient(p.srv)
	if err != nil {
		p.perfRes.Warnings = append(p.perfRes.Warnings, fmt.Sprintf("collect perf record: %v", err))
		p.perfRes.Status = "unavailable"
		p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return
	}
	defer client.Close()

	dataPath := p.basePath + ".data"
	scriptPath := p.basePath + ".script"
	out, _ := runPerfSSHCommand(client, "cat "+shellQuote(p.basePath+".out")+" 2>/dev/null || true")
	errOut, _ := runPerfSSHCommand(client, "cat "+shellQuote(p.basePath+".err")+" 2>/dev/null || true")
	p.perfRes.RawOutput = out
	p.perfRes.RawError = errOut
	scriptCmd := "sudo perf script -i " + shellQuote(dataPath) + " > " + shellQuote(scriptPath)
	if scriptOut, err := runPerfSSHCommand(client, scriptCmd); err != nil {
		p.perfRes.RawError += scriptOut
		p.perfRes.Warnings = append(p.perfRes.Warnings, fmt.Sprintf("perf script: %v", err))
	}
	reportCmd := "sudo perf report --stdio --no-children --call-graph=none -q -i " + shellQuote(dataPath) + " 2>/dev/null | head -30"
	reportOut, _ := runPerfSSHCommand(client, reportCmd)
	p.perfRes.TopFunctions = parsePerfReportTopFunctions(reportOut)
	p.perfRes.ScriptOutput, _ = runPerfSSHCommand(client, "cat "+shellQuote(scriptPath)+" 2>/dev/null || true")
	_, _ = runPerfSSHCommand(client, "rm -f "+shellQuote(p.basePath+".out")+" "+shellQuote(p.basePath+".err")+" "+shellQuote(p.basePath+".pid")+" "+shellQuote(dataPath)+" "+shellQuote(scriptPath))
	p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	if len(p.perfRes.TopFunctions) > 0 || p.perfRes.ScriptOutput != "" {
		p.perfRes.Status = "completed"
	} else {
		p.perfRes.Status = "unavailable"
	}
}

func collectPerfTrace(p *pendingPerfCollect) {
	out, errOut, warnings := collectDetachedPerfFiles(p.srv, p.basePath, true)
	p.perfRes.RawOutput = out
	p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	p.perfRes.RawError = errOut
	p.perfRes.Warnings = append(p.perfRes.Warnings, warnings...)
	p.perfRes.SyscallSummary = parsePerfTraceSummary(errOut + "\n" + out)
	if len(p.perfRes.SyscallSummary) > 0 {
		p.perfRes.Status = "completed"
	} else {
		p.perfRes.Status = "unavailable"
	}
}

func buildPerfC2cCmd(step plan.Step, opts RunOpts, durationSecs int, basePath string, perfRes *result.PerfResult) (string, error) {
	dataPath := basePath + ".data"
	args := []string{"sudo", "perf", "c2c", "record", "-a"}
	if cg := resolvePerfCgroup(step, opts); cg != "" {
		args = append(args, "-G", shellQuote(cg))
	}
	ldlat := strings.TrimSpace(plan.SubstituteParams(step.PerfLdlat, opts.Plan.Params))
	if ldlat != "" {
		if _, err := strconv.Atoi(ldlat); err != nil {
			perfRes.Warnings = append(perfRes.Warnings, fmt.Sprintf("perf ldlat %q is not a number; using default", step.PerfLdlat))
		} else {
			args = append(args, fmt.Sprintf("--ldlat=%s", ldlat))
		}
	}
	// Use frame-pointer-based call graph unwinding. PGDG postgresql packages are
	// compiled with -fno-omit-frame-pointer so FP unwinding is accurate and has
	// lower overhead than --call-graph dwarf. This gives c2c proper call-chain
	// context for the Pareto distribution section.
	args = append(args, "--call-graph", "fp")
	args = append(args, "-o", shellQuote(dataPath), "--", "sleep", strconv.Itoa(durationSecs))
	return strings.Join(args, " "), nil
}

func collectPerfC2c(p *pendingPerfCollect) {
	client, err := newPerfSSHClient(p.srv)
	if err != nil {
		p.perfRes.Warnings = append(p.perfRes.Warnings, fmt.Sprintf("collect perf c2c: %v", err))
		p.perfRes.Status = "unavailable"
		p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return
	}
	defer client.Close()

	dataPath := p.basePath + ".data"
	out, _ := runPerfSSHCommand(client, "cat "+shellQuote(p.basePath+".out")+" 2>/dev/null || true")
	errOut, _ := runPerfSSHCommand(client, "cat "+shellQuote(p.basePath+".err")+" 2>/dev/null || true")
	p.perfRes.RawOutput = out
	p.perfRes.RawError = errOut

	reportCmd := "sudo perf c2c report -i " + shellQuote(dataPath) + " --stdio 2>/dev/null"
	reportOut, reportErr := runPerfSSHCommand(client, reportCmd)
	if reportErr != nil {
		p.perfRes.Warnings = append(p.perfRes.Warnings, fmt.Sprintf("perf c2c report: %v", reportErr))
	}
	p.perfRes.C2cReport = reportOut
	if reportOut != "" {
		p.perfRes.C2cSummary, p.perfRes.SharedLines = parseC2cReport(reportOut)
		p.perfRes.SharedLines = resolvePostgresC2cSymbols(client, p.perfRes.SharedLines)
	}

	_, _ = runPerfSSHCommand(client, "rm -f "+shellQuote(p.basePath+".out")+" "+shellQuote(p.basePath+".err")+" "+shellQuote(p.basePath+".pid")+" "+shellQuote(dataPath))
	p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	if p.perfRes.C2cSummary != nil {
		p.perfRes.Status = "completed"
	} else {
		p.perfRes.Status = "unavailable"
	}
}

// parseC2cReport parses the text output of `perf c2c report --stdio` into
// structured C2cSummary and a list of contested C2cLines.
func parseC2cReport(report string) (*result.C2cSummary, []result.C2cLine) {
	const (
		secNone   = iota
		secTrace  // "Trace Event Information"
		secGlobal // "Global Shared Cache Line Event Information"
		secTable  // "Shared Data Cache Line Table"
		secPareto // "Shared Cache Line Distribution Pareto"
	)
	section := secNone
	summary := &result.C2cSummary{}
	var lines []result.C2cLine
	var currentLine *result.C2cLine
	inHeader := false // next non-separator, non-comment pareto line is a cache-line header

	for _, rawLine := range strings.Split(report, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		// Section header detection (lines wrapped in "====")
		if strings.HasPrefix(line, "=") {
			continue
		}
		if strings.Contains(line, "Trace Event Information") {
			section = secTrace
			continue
		}
		if strings.Contains(line, "Global Shared Cache Line Event") {
			section = secGlobal
			continue
		}
		if strings.Contains(line, "Shared Data Cache Line Table") {
			section = secTable
			continue
		}
		if strings.Contains(line, "Shared Cache Line Distribution Pareto") {
			section = secPareto
			continue
		}
		if strings.Contains(line, "c2c details") {
			section = secNone
			continue
		}

		switch section {
		case secTrace, secGlobal:
			if strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				continue
			}
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			n, err := strconv.Atoi(val)
			if err != nil {
				continue
			}
			switch key {
			case "Total records":
				summary.TotalRecords = n
			case "Load Local HITM":
				summary.LclHitm = n
				summary.TotalHitm += n
			case "Load Remote HITM":
				summary.RmtHitm = n
				summary.TotalHitm += n
			case "Store L1D Miss":
				summary.StoreL1dMiss = n
			case "Total Shared Cache Lines":
				summary.SharedCacheLines = n
			}

		case secTable:
			if strings.HasPrefix(line, "#") {
				continue
			}
			fields := strings.Fields(line)
			// Row format: Index Address Node PA_cnt Tot_Hitm% Total LclHitm RmtHitm Records ...
			if len(fields) < 9 || !strings.HasPrefix(fields[1], "0x") {
				continue
			}
			lclHitm, err1 := strconv.Atoi(fields[6])
			rmtHitm, err2 := strconv.Atoi(fields[7])
			records, err3 := strconv.Atoi(fields[8])
			if err1 != nil || err2 != nil || err3 != nil {
				continue
			}
			lines = append(lines, result.C2cLine{
				Address: fields[1],
				LclHitm: lclHitm,
				RmtHitm: rmtHitm,
				Records: records,
			})

		case secPareto:
			if strings.HasPrefix(line, "#") {
				continue
			}
			// Separator line (all dashes): the NEXT non-comment, non-separator line
			// alternates between cache-line header and access lines. We track this
			// with a simple state: after separator, if fields look like a header
			// (no '%', 7 fields, last starts with 0x), treat as header.
			if strings.HasPrefix(line, "---") {
				inHeader = !inHeader
				continue
			}
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}

			// Cache-line header: comes right after first separator of a block.
			// Format: Num  RmtHitm  LclHitm  L1Hit  L1Miss  N/A  Address
			if inHeader && len(fields) == 7 && strings.HasPrefix(fields[6], "0x") && !strings.Contains(fields[0], "%") {
				addr := fields[6]
				currentLine = nil
				for i := range lines {
					if lines[i].Address == addr {
						currentLine = &lines[i]
						break
					}
				}
				inHeader = false
				continue
			}

			// Access line: fields[0] ends with '%'
			if !strings.HasSuffix(fields[0], "%") || len(fields) < 18 {
				continue
			}
			// Format: RmtPct% LclPct% L1HitPct% L1MissPct% NAPct%
			//         Offset Node PACnt CodeAddr
			//         RmtCycles LclCycles LoadCycles Records CPUCnt
			//         [Symbol tokens...] Object SourceLine Node
			rmtPct, _ := strconv.ParseFloat(strings.TrimSuffix(fields[0], "%"), 64)
			lclPct, _ := strconv.ParseFloat(strings.TrimSuffix(fields[1], "%"), 64)
			offset := fields[5]
			lclCycles, _ := strconv.Atoi(fields[10])

			// Last 3 tokens: Object, SourceLine, trailing Node integer
			// Everything from index 14 to len-3 is the Symbol (may have spaces)
			symbol := strings.Join(fields[14:len(fields)-3], " ")
			object := fields[len(fields)-3]
			srcLine := fields[len(fields)-2]

			access := result.C2cAccess{
				Symbol:     symbol,
				Object:     object,
				SourceLine: srcLine,
				Offset:     offset,
				LclHitmPct: lclPct,
				RmtHitmPct: rmtPct,
				LclCycles:  lclCycles,
			}
			if currentLine != nil {
				currentLine.Accesses = append(currentLine.Accesses, access)
			}
		}
	}

	return summary, lines
}

func cleanupPendingPerfs(perfs []pendingPerfCollect) {
	for i := range perfs {
		p := &perfs[i]
		if p.basePath == "" {
			continue
		}
		_, _ = runPerfSSHCommandOnce(p.srv, "rm -f "+shellQuote(p.basePath+".out")+" "+shellQuote(p.basePath+".err")+" "+shellQuote(p.basePath+".pid")+" "+shellQuote(p.basePath+".data")+" "+shellQuote(p.basePath+".script"))
	}
}

func resolvePerfDelay(step plan.Step, params []plan.Param) (int, string) {
	return resolvePerfDelayValue(step.PerfDelay, params)
}

func resolvePerfDelayForMode(step plan.Step, mode string, params []plan.Param) (int, string) {
	modeDelay := step.PerfDelay
	switch mode {
	case "stat":
		if strings.TrimSpace(step.PerfStatDelay) != "" {
			modeDelay = step.PerfStatDelay
		}
	case "record":
		if strings.TrimSpace(step.PerfRecordDelay) != "" {
			modeDelay = step.PerfRecordDelay
		}
	case "trace":
		if strings.TrimSpace(step.PerfTraceDelay) != "" {
			modeDelay = step.PerfTraceDelay
		}
	case "c2c":
		if strings.TrimSpace(step.PerfC2cDelay) != "" {
			modeDelay = step.PerfC2cDelay
		}
	}
	return resolvePerfDelayValue(modeDelay, params)
}

func resolvePerfDelayValue(value string, params []plan.Param) (int, string) {
	if strings.TrimSpace(value) == "" {
		return 0, ""
	}
	raw := strings.TrimSpace(plan.SubstituteParams(value, params))
	if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
		return n, ""
	}
	if strings.Contains(raw, "{{") || strings.Contains(raw, "}}") {
		return 0, fmt.Sprintf("perf delay %q did not resolve to a number; using 0", value)
	}
	return 0, fmt.Sprintf("perf delay %q is not a non-negative number; using 0", value)
}

func startDetachedPerfCommand(srv plan.ServerConfig, basePath string, perfCmd string) (string, error) {
	startCmd := fmt.Sprintf(
		"rm -f %[1]s.out %[1]s.err %[1]s.pid; (nohup %[2]s >%[1]s.out 2>%[1]s.err < /dev/null & echo $! >%[1]s.pid)",
		shellQuote(basePath),
		perfCmd,
	)
	return runPerfSSHCommandOnce(srv, startCmd)
}

func collectDetachedPerfFiles(srv plan.ServerConfig, basePath string, cleanup bool) (string, string, []string) {
	client, err := newPerfSSHClient(srv)
	if err != nil {
		return "", "", []string{fmt.Sprintf("collect detached perf output: %v", err)}
	}
	defer client.Close()

	out, _ := runPerfSSHCommand(client, "cat "+shellQuote(basePath+".out")+" 2>/dev/null || true")
	errOut, _ := runPerfSSHCommand(client, "cat "+shellQuote(basePath+".err")+" 2>/dev/null || true")
	if cleanup {
		_, _ = runPerfSSHCommand(client, "rm -f "+shellQuote(basePath+".out")+" "+shellQuote(basePath+".err")+" "+shellQuote(basePath+".pid"))
	}
	return out, errOut, nil
}

func runPerfSSHCommandOnce(srv plan.ServerConfig, cmd string) (string, error) {
	client, err := newPerfSSHClient(srv)
	if err != nil {
		return "", err
	}
	defer client.Close()
	return runPerfSSHCommand(client, cmd)
}

func parsePerfReportTopFunctions(output string) []result.PerfTopFunction {
	var rows []result.PerfTopFunction
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "%") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 || !strings.HasSuffix(fields[0], "%") {
			continue
		}
		overhead, err := strconv.ParseFloat(strings.TrimSuffix(fields[0], "%"), 64)
		if err != nil {
			continue
		}
		dso := fields[len(fields)-1]
		symbol := strings.Join(fields[1:len(fields)-1], " ")
		if len(fields) >= 4 {
			dso = fields[2]
			symbol = strings.Join(fields[3:], " ")
		}
		rows = append(rows, result.PerfTopFunction{Overhead: overhead, Symbol: symbol, DSO: dso})
		if len(rows) >= 30 {
			break
		}
	}
	return rows
}

func parsePerfTraceSummary(output string) []result.SyscallEntry {
	var rows []result.SyscallEntry
	process := ""
	pid := 0
	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if processName, processPID, ok := parsePerfTraceSummaryHeader(line); ok {
			process = processName
			pid = processPID
			continue
		}
		if strings.HasSuffix(line, ":") && !strings.Contains(line, " ") {
			process, pid = parsePerfTraceProcess(strings.TrimSuffix(line, ":"))
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 7 || fields[0] == "syscall" || strings.HasPrefix(fields[0], "---") {
			continue
		}
		calls, errCalls := strconv.Atoi(fields[1])
		errorsCount, errErrors := strconv.Atoi(fields[2])
		total, errTotal := strconv.ParseFloat(fields[3], 64)
		min, errMin := strconv.ParseFloat(fields[4], 64)
		avg, errAvg := strconv.ParseFloat(fields[5], 64)
		max, errMax := strconv.ParseFloat(fields[6], 64)
		if errCalls != nil || errErrors != nil || errTotal != nil || errMin != nil || errAvg != nil || errMax != nil {
			continue
		}
		syscall := fields[0]
		rows = append(rows, result.SyscallEntry{
			Process: process,
			PID:     pid,
			Syscall: syscall,
			Calls:   calls,
			Errors:  errorsCount,
			TotalMs: total,
			MinMs:   min,
			AvgMs:   avg,
			MaxMs:   max,
		})
	}
	return rows
}

var perfTraceSummaryHeaderRe = regexp.MustCompile(`^(.+?\(\d+\)),\s+\d+\s+events,\s+[0-9.]+%$`)

func parsePerfTraceSummaryHeader(line string) (string, int, bool) {
	m := perfTraceSummaryHeaderRe.FindStringSubmatch(line)
	if m == nil {
		return "", 0, false
	}
	process, pid := parsePerfTraceProcess(m[1])
	return process, pid, true
}

func parsePerfTraceProcess(raw string) (string, int) {
	open := strings.LastIndex(raw, "(")
	close := strings.LastIndex(raw, ")")
	if open >= 0 && close > open {
		pid, _ := strconv.Atoi(raw[open+1 : close])
		return strings.TrimSpace(raw[:open]), pid
	}
	return strings.TrimSpace(raw), 0
}

// pgSym holds an address → name entry from nm output.
type pgSym struct {
	addr uint64
	name string
}

// fetchNmSymbols runs `nm --defined-only -n` against path over SSH and returns
// the sorted symbol table (text/function symbols only). Returns nil if the
// binary is stripped or nm fails.
func fetchNmSymbols(client *ssh.Client, path string) []pgSym {
	out, err := runPerfSSHCommand(client,
		"nm --defined-only -n "+shellQuote(path)+" 2>/dev/null | grep ' [Tt] '")
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}
	var syms []pgSym
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		addr, err := strconv.ParseUint(fields[0], 16, 64)
		if err != nil {
			continue
		}
		syms = append(syms, pgSym{addr, fields[2]})
	}
	return syms
}

// fetchPostgresSymbolTable tries to obtain a sorted function symbol table for
// the postgres binary over SSH. It first tries the binary itself (works for
// non-stripped builds), then falls back to the debug symbols file installed by
// postgresql-18-dbgsym (at /usr/lib/debug/.build-id/<xx>/<rest>.debug).
func fetchPostgresSymbolTable(client *ssh.Client) []pgSym {
	// Locate the postgres binary via pg_config
	binDirOut, _ := runPerfSSHCommand(client, "pg_config --bindir 2>/dev/null")
	binDir := strings.TrimSpace(binDirOut)
	if binDir == "" {
		return nil
	}
	pgBin := binDir + "/postgres"

	// Try direct nm (works if binary has a symbol table)
	if syms := fetchNmSymbols(client, pgBin); len(syms) > 0 {
		return syms
	}

	// Fallback: find debug symbols via Build ID
	buildIDOut, _ := runPerfSSHCommand(client,
		"readelf -n "+shellQuote(pgBin)+" 2>/dev/null | awk '/Build ID:/{print $NF}'")
	buildID := strings.TrimSpace(buildIDOut)
	if len(buildID) < 3 {
		return nil
	}
	debugFile := "/usr/lib/debug/.build-id/" + buildID[:2] + "/" + buildID[2:] + ".debug"
	return fetchNmSymbols(client, debugFile)
}

// findNearestSym binary-searches syms (sorted by addr ascending) for the
// largest entry whose addr ≤ target. Returns the symbol name, its base
// address, and whether a match was found.
func findNearestSym(syms []pgSym, target uint64) (name string, base uint64, ok bool) {
	lo, hi, best := 0, len(syms)-1, -1
	for lo <= hi {
		mid := (lo + hi) / 2
		if syms[mid].addr <= target {
			best = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	if best < 0 {
		return "", 0, false
	}
	return syms[best].name, syms[best].addr, true
}

// unresolvedAddrRe matches unresolved user-space symbols like "[.] 0x5893b0".
var unresolvedAddrRe = regexp.MustCompile(`^\[\.\] (0x[0-9a-f]+)$`)

// pgSourceLineRe matches the source_line field emitted for stripped postgres
// symbols: "postgres[5893b0]".
var pgSourceLineRe = regexp.MustCompile(`^postgres\[[0-9a-f]+\]$`)

// resolvePostgresC2cSymbols enriches SharedLines by resolving unresolved
// user-space postgres symbols ("[.] 0xADDR") to human-readable names using nm.
// It is a no-op if debug symbols are unavailable or all symbols are already
// resolved.
func resolvePostgresC2cSymbols(client *ssh.Client, lines []result.C2cLine) []result.C2cLine {
	if len(lines) == 0 {
		return lines
	}

	// Collect all unresolved addresses so we make a single nm call.
	type ref struct {
		lineIdx, accessIdx int
		addr               uint64
	}
	var refs []ref
	for li := range lines {
		for ai := range lines[li].Accesses {
			m := unresolvedAddrRe.FindStringSubmatch(lines[li].Accesses[ai].Symbol)
			if m == nil {
				continue
			}
			addr, err := strconv.ParseUint(m[1][2:], 16, 64) // strip "0x"
			if err == nil {
				refs = append(refs, ref{li, ai, addr})
			}
		}
	}
	if len(refs) == 0 {
		return lines
	}

	syms := fetchPostgresSymbolTable(client)
	if len(syms) == 0 {
		return lines
	}

	for _, r := range refs {
		name, base, ok := findNearestSym(syms, r.addr)
		if !ok {
			continue
		}
		offset := r.addr - base
		var resolved string
		if offset == 0 {
			resolved = "[.] " + name
		} else {
			resolved = fmt.Sprintf("[.] %s+0x%x", name, offset)
		}
		lines[r.lineIdx].Accesses[r.accessIdx].Symbol = resolved
		// Also clean up the source_line when it looks like "postgres[hexaddr]"
		if pgSourceLineRe.MatchString(lines[r.lineIdx].Accesses[r.accessIdx].SourceLine) {
			if offset == 0 {
				lines[r.lineIdx].Accesses[r.accessIdx].SourceLine = name
			} else {
				lines[r.lineIdx].Accesses[r.accessIdx].SourceLine = fmt.Sprintf("%s+0x%x", name, offset)
			}
		}
	}
	return lines
}
