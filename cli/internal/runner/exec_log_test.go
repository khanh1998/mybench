package runner

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

const mbPrefix = "__MB__"

func readExecLogLines(t *testing.T, f *os.File) []string {
	t.Helper()
	if err := f.Sync(); err != nil {
		t.Fatalf("sync exec log: %v", err)
	}
	if _, err := f.Seek(0, 0); err != nil {
		t.Fatalf("seek exec log: %v", err)
	}
	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines
}

func parseEventLine(t *testing.T, line string) map[string]any {
	t.Helper()
	if !strings.HasPrefix(line, mbPrefix) {
		t.Fatalf("line does not start with %q: %q", mbPrefix, line)
	}
	var evt map[string]any
	if err := json.Unmarshal([]byte(line[len(mbPrefix):]), &evt); err != nil {
		t.Fatalf("parse event JSON from %q: %v", line, err)
	}
	return evt
}

func newTempExecLog(t *testing.T) *os.File {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "execlog-*.log")
	if err != nil {
		t.Fatalf("create temp exec log: %v", err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// ---------------------------------------------------------------------------
// emitEvent
// ---------------------------------------------------------------------------

func TestEmitEventWritesMBPrefixedJSONToExecLog(t *testing.T) {
	f := newTempExecLog(t)
	opts := &RunOpts{ExecLog: f}
	opts.emitEvent(map[string]any{"event": "run_done", "run_index": 0, "status": "completed"})

	lines := readExecLogLines(t, f)
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	evt := parseEventLine(t, lines[0])
	if evt["event"] != "run_done" {
		t.Errorf("event: got %q, want %q", evt["event"], "run_done")
	}
	if evt["status"] != "completed" {
		t.Errorf("status: got %q, want %q", evt["status"], "completed")
	}
	if v, ok := evt["run_index"].(float64); !ok || int(v) != 0 {
		t.Errorf("run_index: got %v, want 0", evt["run_index"])
	}
}

func TestEmitEventNoExecLogDoesNotPanic(t *testing.T) {
	opts := &RunOpts{ExecLog: nil, JSONEvents: false}
	// Should not panic even with nil ExecLog
	opts.emitEvent(map[string]any{"event": "run_done", "status": "completed"})
}

func TestEmitEventMultipleEventsInOrder(t *testing.T) {
	f := newTempExecLog(t)
	opts := &RunOpts{ExecLog: f}

	events := []map[string]any{
		{"event": "step_start", "step_id": 1},
		{"event": "step_done", "step_id": 1, "status": "completed"},
		{"event": "run_done", "status": "completed"},
	}
	for _, evt := range events {
		opts.emitEvent(evt)
	}

	lines := readExecLogLines(t, f)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	for i, line := range lines {
		evt := parseEventLine(t, line)
		if evt["event"] != events[i]["event"] {
			t.Errorf("line %d: event=%q, want %q", i, evt["event"], events[i]["event"])
		}
	}
}

// ---------------------------------------------------------------------------
// logInfo
// ---------------------------------------------------------------------------

func TestLogInfoWritesTimestampedLineToExecLog(t *testing.T) {
	f := newTempExecLog(t)
	opts := &RunOpts{ExecLog: f}

	before := time.Now().UTC().Truncate(time.Second)
	opts.logInfo("[step 0] %q starting", "Init schema")
	after := time.Now().UTC().Add(time.Second)

	lines := readExecLogLines(t, f)
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	line := lines[0]

	// Line must not start with __MB__
	if strings.HasPrefix(line, mbPrefix) {
		t.Errorf("logInfo line should not have %q prefix: %q", mbPrefix, line)
	}

	// Must contain the message
	if !strings.Contains(line, "[step 0]") || !strings.Contains(line, "Init schema") {
		t.Errorf("logInfo line missing message content: %q", line)
	}

	// Must start with an RFC3339 timestamp
	parts := strings.SplitN(line, " ", 2)
	if len(parts) < 2 {
		t.Fatalf("logInfo line has no space-separated timestamp: %q", line)
	}
	ts, err := time.Parse(time.RFC3339, parts[0])
	if err != nil {
		t.Errorf("logInfo timestamp %q is not RFC3339: %v", parts[0], err)
	}
	if ts.Before(before) || ts.After(after) {
		t.Errorf("timestamp %v is outside expected range [%v, %v]", ts, before, after)
	}
}

// ---------------------------------------------------------------------------
// step_start event — output_file field
// ---------------------------------------------------------------------------

func TestStepStartIncludesOutputFileForPgbenchSysbenchSQL(t *testing.T) {
	for _, stepType := range []string{"pgbench", "sysbench", "sql"} {
		t.Run(stepType, func(t *testing.T) {
			f := newTempExecLog(t)
			opts := &RunOpts{ExecLog: f, LogDir: "/tmp/mybench-logs", Timestamp: "20260510T120000Z"}

			stepLogPath := "/tmp/mybench-logs/mybench-20260510T120000Z-benchmark.log"
			evt := map[string]any{
				"event": "step_start", "run_index": 0,
				"step_id": 1, "position": 0, "name": "benchmark", "type": stepType,
			}
			evt["output_file"] = stepLogPath
			opts.emitEvent(evt)

			lines := readExecLogLines(t, f)
			if len(lines) != 1 {
				t.Fatalf("expected 1 line, got %d", len(lines))
			}
			parsed := parseEventLine(t, lines[0])
			if parsed["output_file"] != stepLogPath {
				t.Errorf("output_file: got %q, want %q", parsed["output_file"], stepLogPath)
			}
		})
	}
}

func TestStepStartNoOutputFileForCollectAndStatSteps(t *testing.T) {
	for _, stepType := range []string{"collect", "pg_stat_statements_reset", "pg_stat_statements_collect"} {
		t.Run(stepType, func(t *testing.T) {
			f := newTempExecLog(t)
			opts := &RunOpts{ExecLog: f, LogDir: "/tmp/mybench-logs", Timestamp: "20260510T120000Z"}

			evt := map[string]any{
				"event": "step_start", "run_index": 0,
				"step_id": 2, "position": 1, "name": "collect step", "type": stepType,
			}
			// output_file is NOT included for these types
			opts.emitEvent(evt)

			lines := readExecLogLines(t, f)
			if len(lines) != 1 {
				t.Fatalf("expected 1 line, got %d", len(lines))
			}
			parsed := parseEventLine(t, lines[0])
			if _, hasOutputFile := parsed["output_file"]; hasOutputFile {
				t.Errorf("output_file should not be present for step type %q", stepType)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// run_done event — status field must be parseable by SvelteKit
// ---------------------------------------------------------------------------

func TestRunDoneStatusIsCompletedOrFailed(t *testing.T) {
	for _, wantStatus := range []string{"completed", "failed"} {
		t.Run(wantStatus, func(t *testing.T) {
			f := newTempExecLog(t)
			opts := &RunOpts{ExecLog: f}
			opts.emitEvent(map[string]any{"event": "run_done", "run_index": 0, "status": wantStatus})

			lines := readExecLogLines(t, f)
			evt := parseEventLine(t, lines[0])
			if evt["status"] != wantStatus {
				t.Errorf("status: got %q, want %q", evt["status"], wantStatus)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Exec log is parseable as __MB__ lines by SvelteKit's tail logic
// ---------------------------------------------------------------------------

// This mirrors the logic in SvelteKit's stream endpoints:
// lines starting with __MB__ are parsed as JSON events; others are forwarded as-is.
func TestExecLogIsTailParseable(t *testing.T) {
	f := newTempExecLog(t)
	opts := &RunOpts{ExecLog: f}

	// Simulate a minimal run sequence
	opts.emitEvent(map[string]any{"event": "step_start", "step_id": 1, "run_index": 0})
	opts.logInfo("[step 0] \"Init schema\" starting")
	opts.emitEvent(map[string]any{"event": "step_done", "step_id": 1, "status": "completed", "exit_code": 0, "run_index": 0})
	opts.logInfo("[step 0] \"Init schema\" done")
	opts.emitEvent(map[string]any{"event": "run_done", "run_index": 0, "status": "completed"})

	lines := readExecLogLines(t, f)
	if len(lines) != 5 {
		t.Fatalf("expected 5 lines, got %d:\n%s", len(lines), strings.Join(lines, "\n"))
	}

	var mbLines, plainLines int
	for _, line := range lines {
		if strings.HasPrefix(line, mbPrefix) {
			mbLines++
			var tmp map[string]any
			if err := json.Unmarshal([]byte(line[len(mbPrefix):]), &tmp); err != nil {
				t.Errorf("invalid JSON in MB line %q: %v", line, err)
			}
		} else {
			plainLines++
		}
	}
	if mbLines != 3 {
		t.Errorf("expected 3 __MB__ lines, got %d", mbLines)
	}
	if plainLines != 2 {
		t.Errorf("expected 2 plain lines, got %d", plainLines)
	}

	// Last line must be run_done with status=completed
	lastEvt := parseEventLine(t, lines[4])
	if lastEvt["event"] != "run_done" {
		t.Errorf("last MB line event: got %q, want run_done", lastEvt["event"])
	}
	if lastEvt["status"] != "completed" {
		t.Errorf("last MB line status: got %q, want completed", lastEvt["status"])
	}
}
