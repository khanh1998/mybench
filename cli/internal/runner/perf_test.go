package runner

import (
	"testing"

	"github.com/khanh1998/mybench/cli/internal/plan"
)

func TestParsePerfStatOutput(t *testing.T) {
	out := "1000\t\tcycles\t1.000000\t100.00\n2000\t\tinstructions\t1.000000\t100.00\n<not supported>\t\tcache-misses\t0.000000\t0.00\n# comment\n"
	events, warnings := parsePerfStatOutput(out, 10)
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
	if events[0].EventName != "cycles" || events[0].CounterValue == nil || *events[0].CounterValue != 1000 {
		t.Fatalf("unexpected first event: %+v", events[0])
	}
	if events[0].PerTransaction == nil || *events[0].PerTransaction != 100 {
		t.Fatalf("expected cycles/tx 100, got %+v", events[0].PerTransaction)
	}
	if events[1].EventName != "instructions" {
		t.Fatalf("unexpected second event: %+v", events[1])
	}
	if len(warnings) == 0 {
		t.Fatalf("expected warning for unsupported event")
	}
}

func TestParsePerfFloat(t *testing.T) {
	if v, ok := parsePerfFloat("1,234.5"); !ok || v != 1234.5 {
		t.Fatalf("expected comma-stripped float, got %v %v", v, ok)
	}
	if _, ok := parsePerfFloat("<not counted>"); ok {
		t.Fatalf("expected pseudo counter to fail")
	}
}

func TestParsePerfStatOutputWithCgroupColumn(t *testing.T) {
	out := "1000\t\tcycles\t/system.slice/postgresql.service\t1.000000\t100.00\n"
	events, warnings := parsePerfStatOutput(out, 10)
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].RuntimeSecs == nil || *events[0].RuntimeSecs != 1 {
		t.Fatalf("expected runtime from cgroup output, got %+v", events[0].RuntimeSecs)
	}
	if events[0].PercentRunning == nil || *events[0].PercentRunning != 100 {
		t.Fatalf("expected running percent from cgroup output, got %+v", events[0].PercentRunning)
	}
}

func TestResolvePerfDurationSubstitutesParams(t *testing.T) {
	step := plan.Step{PerfDuration: "{{DURATION_SECS}}"}
	got, warning := resolvePerfDuration(step, []plan.Param{{Name: "DURATION_SECS", Value: "180"}})
	if warning != "" {
		t.Fatalf("unexpected warning: %s", warning)
	}
	if got != 180 {
		t.Fatalf("expected 180, got %d", got)
	}
}

func TestResolvePerfDurationAcceptsNumber(t *testing.T) {
	step := plan.Step{PerfDuration: "240"}
	got, warning := resolvePerfDuration(step, nil)
	if warning != "" {
		t.Fatalf("unexpected warning: %s", warning)
	}
	if got != 240 {
		t.Fatalf("expected 240, got %d", got)
	}
}

func TestResolvePerfDurationSkipsEmpty(t *testing.T) {
	got, warning := resolvePerfDuration(plan.Step{}, nil)
	if got != 0 {
		t.Fatalf("expected skipped duration 0, got %d", got)
	}
	if warning == "" {
		t.Fatalf("expected warning for empty duration")
	}
}

func TestResolvePerfDurationSkipsUnresolvedParam(t *testing.T) {
	got, warning := resolvePerfDuration(plan.Step{PerfDuration: "{{DURATION_SECS}}"}, nil)
	if got != 0 {
		t.Fatalf("expected skipped duration 0, got %d", got)
	}
	if warning == "" {
		t.Fatalf("expected warning for unresolved duration")
	}
}

func TestResolvePerfDurationSkipsInvalidNumber(t *testing.T) {
	got, warning := resolvePerfDuration(plan.Step{PerfDuration: "0"}, nil)
	if got != 0 {
		t.Fatalf("expected skipped duration 0, got %d", got)
	}
	if warning == "" {
		t.Fatalf("expected warning for invalid duration")
	}
}

func TestProcessMatchPatternAvoidsMatchingItself(t *testing.T) {
	got := processMatchPattern("mybench-perf-token")
	if got != "[m]ybench-perf-token" {
		t.Fatalf("unexpected process match pattern: %s", got)
	}
}
