package runner

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
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
	default:
		p.perfRes.Status = "unavailable"
		p.perfRes.Warnings = append(p.perfRes.Warnings, fmt.Sprintf("unknown perf mode %q", p.mode))
		p.perfRes.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	}
}

func buildPerfStatCmd(step plan.Step, opts RunOpts, durationSecs int, perfRes *result.PerfResult) (string, error) {
	events := strings.TrimSpace(step.PerfEvents)
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

	dataPath := basePath + ".data"
	args := []string{"sudo", "perf", "record", "-F", freq, "--call-graph", shellQuote(callGraph), "-a"}
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
