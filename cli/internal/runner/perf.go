package runner

import (
	"bytes"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
	"golang.org/x/crypto/ssh"
)

const defaultPerfEvents = "task-clock,cpu-clock,context-switches,cpu-migrations,page-faults,minor-faults,major-faults"

type perfCollector struct {
	srv       plan.ServerConfig
	client    *ssh.Client
	res       *result.PerfResult
	token     string
	basePath  string
	duration  int
	startedAt time.Time
}

func maybeStartPerf(srv plan.ServerConfig, step plan.Step, params []plan.Param, _ int) (*perfCollector, *result.PerfResult) {
	if !step.CollectPerf {
		return nil, nil
	}
	res := &result.PerfResult{
		Status:    "unavailable",
		Scope:     srv.PerfScope,
		Cgroup:    srv.PerfCgroup,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
	}
	durationSecs, warning := resolvePerfDuration(step, params)
	if warning != "" {
		res.Warnings = append(res.Warnings, warning)
		res.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return nil, res
	}
	if !srv.PerfEnabled || srv.PerfScope == "" || srv.PerfScope == "disabled" {
		res.Warnings = append(res.Warnings, "perf is disabled for this PostgreSQL server")
		return nil, res
	}
	if !srv.SSHEnabled || srv.SSHUser == "" || srv.SSHPrivateKey == "" {
		res.Warnings = append(res.Warnings, "DB SSH credentials are not configured")
		return nil, res
	}

	client, err := newPerfSSHClient(srv)
	if err != nil {
		res.Warnings = append(res.Warnings, err.Error())
		return nil, res
	}

	token := fmt.Sprintf("mybench-perf-%d", time.Now().UnixNano())
	basePath := "/tmp/" + token

	events := srv.PerfEvents
	if strings.TrimSpace(events) == "" {
		events = defaultPerfEvents
	}
	args := []string{"sudo", "nohup", "env", "LC_ALL=C", "perf", "stat", "-x", "'\\t'", "-a", "-e", shellQuote(events)}
	if srv.PerfScope == "postgres_cgroup" && srv.PerfCgroup != "" {
		args = append(args, "-G", shellQuote(srv.PerfCgroup))
	}
	args = append(args, "--", "bash", "-c", shellQuote("exec -a "+token+" sleep "+strconv.Itoa(durationSecs)))
	perfCmd := strings.Join(args, " ")
	startCmd := fmt.Sprintf(
		"rm -f %[1]s.out %[1]s.err %[1]s.pid; (%[2]s >%[1]s.out 2>%[1]s.err & echo $! >%[1]s.pid)",
		shellQuote(basePath),
		perfCmd,
	)
	res.Command = perfCmd
	res.Status = "running"

	if out, err := runPerfSSHCommand(client, startCmd); err != nil {
		client.Close()
		res.Status = "unavailable"
		res.RawError = out
		res.Warnings = append(res.Warnings, fmt.Sprintf("start detached perf: %v", err))
		return nil, res
	}
	return &perfCollector{
		srv:       srv,
		client:    client,
		res:       res,
		token:     token,
		basePath:  basePath,
		duration:  durationSecs,
		startedAt: time.Now(),
	}, res
}

func (c *perfCollector) Stop(transactions int64) *result.PerfResult {
	if c == nil {
		return nil
	}
	defer c.client.Close()

	pattern := shellQuote(processMatchPattern(c.token))
	_, _ = runPerfSSHCommand(c.client, fmt.Sprintf("pkill -INT -f %s || true", pattern))
	if !c.waitForRemoteExit(5 * time.Second) {
		c.res.Warnings = append(c.res.Warnings, "remote perf did not stop after INT; sending TERM")
		_, _ = runPerfSSHCommand(c.client, fmt.Sprintf("pkill -TERM -f %s || true", pattern))
		_ = c.waitForRemoteExit(5 * time.Second)
	}

	out, _ := runPerfSSHCommand(c.client, "cat "+shellQuote(c.basePath+".out")+" 2>/dev/null || true")
	errOut, _ := runPerfSSHCommand(c.client, "cat "+shellQuote(c.basePath+".err")+" 2>/dev/null || true")
	_, _ = runPerfSSHCommand(c.client, "rm -f "+shellQuote(c.basePath+".out")+" "+shellQuote(c.basePath+".err")+" "+shellQuote(c.basePath+".pid"))

	c.res.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	c.res.RawOutput = out
	c.res.RawError = errOut
	events, warnings := parsePerfStatOutput(c.res.RawError, transactions)
	c.res.Events = events
	c.res.Warnings = append(c.res.Warnings, warnings...)
	if len(c.res.Events) > 0 {
		c.res.Status = "completed"
	} else {
		c.res.Status = "unavailable"
	}
	return c.res
}

func (c *perfCollector) waitForRemoteExit(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	pattern := shellQuote(processMatchPattern(c.token))
	for time.Now().Before(deadline) {
		out, _ := runPerfSSHCommand(c.client, fmt.Sprintf("pgrep -f %s || true", pattern))
		if strings.TrimSpace(out) == "" {
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

func newPerfSSHClient(srv plan.ServerConfig) (*ssh.Client, error) {
	signer, err := ssh.ParsePrivateKey([]byte(srv.SSHPrivateKey))
	if err != nil {
		return nil, fmt.Errorf("parse SSH key: %w", err)
	}
	sshHost := srv.SSHHost
	if sshHost == "" {
		sshHost = srv.Host
	}
	sshPort := srv.SSHPort
	if sshPort == 0 {
		sshPort = 22
	}
	return ssh.Dial("tcp", net.JoinHostPort(sshHost, strconv.Itoa(sshPort)), &ssh.ClientConfig{
		User:            srv.SSHUser,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec — internal benchmark tooling
		Timeout:         15 * time.Second,
	})
}

func runPerfSSHCommand(client *ssh.Client, cmd string) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	var out bytes.Buffer
	var errOut bytes.Buffer
	session.Stdout = &out
	session.Stderr = &errOut
	err = session.Run(cmd)
	return out.String() + errOut.String(), err
}

func resolvePerfDuration(step plan.Step, params []plan.Param) (int, string) {
	if strings.TrimSpace(step.PerfDuration) == "" {
		return 0, "perf duration is empty; skipping perf"
	}
	raw := strings.TrimSpace(plan.SubstituteParams(step.PerfDuration, params))
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		return n, ""
	}
	if strings.Contains(raw, "{{") || strings.Contains(raw, "}}") {
		return 0, fmt.Sprintf("perf duration %q did not resolve to a number; skipping perf", step.PerfDuration)
	}
	return 0, fmt.Sprintf("perf duration %q is not a positive number; skipping perf", step.PerfDuration)
}

func parseDurationFromArgs(args []string, flag string) int {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			if n, err := strconv.Atoi(args[i+1]); err == nil && n > 0 {
				return n
			}
		}
		if strings.HasPrefix(arg, flag+"=") {
			if n, err := strconv.Atoi(strings.TrimPrefix(arg, flag+"=")); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

func parseSysbenchDuration(args []string) int {
	for i, arg := range args {
		if arg == "--time" && i+1 < len(args) {
			if n, err := strconv.Atoi(args[i+1]); err == nil && n > 0 {
				return n
			}
		}
		if strings.HasPrefix(arg, "--time=") {
			if n, err := strconv.Atoi(strings.TrimPrefix(arg, "--time=")); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

func parsePerfStatOutput(output string, transactions int64) ([]result.PerfEvent, []string) {
	var events []result.PerfEvent
	var warnings []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 3 {
			if strings.Contains(line, "not supported") || strings.Contains(line, "No permission") || strings.Contains(line, "failed") {
				warnings = append(warnings, line)
			}
			continue
		}
		rawValue := strings.TrimSpace(parts[0])
		eventName := strings.TrimSpace(parts[2])
		if eventName == "" {
			continue
		}
		ev := result.PerfEvent{EventName: eventName, Unit: strings.TrimSpace(parts[1])}
		if v, ok := parsePerfFloat(rawValue); ok {
			ev.CounterValue = &v
			if transactions > 0 {
				perTxn := v / float64(transactions)
				ev.PerTransaction = &perTxn
			}
		} else {
			warnings = append(warnings, fmt.Sprintf("%s: %s", eventName, rawValue))
		}
		runtimeIdx := 3
		if len(parts) > 3 && strings.HasPrefix(strings.TrimSpace(parts[3]), "/") {
			runtimeIdx = 4
		}
		if len(parts) > runtimeIdx {
			if v, ok := parsePerfFloat(parts[runtimeIdx]); ok {
				runtimeSecs := v / 1_000_000_000
				ev.RuntimeSecs = &runtimeSecs
			}
		}
		if len(parts) > runtimeIdx+1 {
			if v, ok := parsePerfFloat(strings.TrimSuffix(parts[runtimeIdx+1], "%")); ok {
				ev.PercentRunning = &v
			}
		}
		if len(parts) > runtimeIdx+2 {
			if v, ok := parsePerfFloat(parts[runtimeIdx+2]); ok {
				ev.DerivedValue = &v
				if len(parts) > runtimeIdx+3 {
					ev.DerivedUnit = strings.TrimSpace(strings.Join(parts[runtimeIdx+3:], " "))
				}
			}
		}
		events = append(events, ev)
	}
	return events, warnings
}

func parsePerfFloat(raw string) (float64, bool) {
	cleaned := strings.TrimSpace(strings.ReplaceAll(raw, ",", ""))
	if cleaned == "" || strings.HasPrefix(cleaned, "<") {
		return 0, false
	}
	v, err := strconv.ParseFloat(cleaned, 64)
	return v, err == nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func processMatchPattern(token string) string {
	if token == "" {
		return token
	}
	return "[" + token[:1] + "]" + token[1:]
}
