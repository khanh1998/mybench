package runner

import (
	"testing"

	"github.com/khanh1998/mybench/cli/internal/plan"
)

func TestParsePerfStatOutput(t *testing.T) {
	out := "1000\t\tcycles\t1000000000\t100.00\n2000\t\tinstructions\t1000000000\t100.00\n<not supported>\t\tcache-misses\t0\t0.00\n# comment\n"
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
	out := "1000\t\tcycles\t/system.slice/postgresql.service\t1000000000\t100.00\t33.300\t/sec\n"
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
	if events[0].DerivedValue == nil || *events[0].DerivedValue != 33.3 {
		t.Fatalf("expected derived value from cgroup output, got %+v", events[0].DerivedValue)
	}
	if events[0].DerivedUnit != "/sec" {
		t.Fatalf("expected derived unit from cgroup output, got %q", events[0].DerivedUnit)
	}
}

func TestParsePerfStatOutputWithRelativeCgroupColumn(t *testing.T) {
	// cgroup path like "system.slice/postgresql.service" does not start with "/"
	out := "141149.50\tmsec\ttask-clock\tsystem.slice/system-postgresql.slice/postgresql@18-main.service\t141161533873\t100.00\t0.784\tCPUs utilized\n"
	events, warnings := parsePerfStatOutput(out, 1000)
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].RuntimeSecs == nil {
		t.Fatalf("expected runtime_secs to be set, got nil")
	}
	if *events[0].RuntimeSecs < 141 || *events[0].RuntimeSecs > 142 {
		t.Fatalf("expected ~141 runtime_secs, got %v", *events[0].RuntimeSecs)
	}
	if events[0].PercentRunning == nil || *events[0].PercentRunning != 100 {
		t.Fatalf("expected percent_running=100, got %+v", events[0].PercentRunning)
	}
	if events[0].DerivedValue == nil || *events[0].DerivedValue != 0.784 {
		t.Fatalf("expected derived_value=0.784, got %+v", events[0].DerivedValue)
	}
	if events[0].DerivedUnit != "CPUs utilized" {
		t.Fatalf("expected derived_unit='CPUs utilized', got %q", events[0].DerivedUnit)
	}
}

func TestParsePerfStatOutputCpuUtilization(t *testing.T) {
	out := "302860.42\tmsec\ttask-clock\t/system.slice/postgresql.service\t302864094660\t100.00\t1.683\tCPUs utilized\n"
	events, warnings := parsePerfStatOutput(out, 4387)
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].RuntimeSecs == nil || *events[0].RuntimeSecs != 302.86409466 {
		t.Fatalf("expected runtime seconds, got %+v", events[0].RuntimeSecs)
	}
	if events[0].DerivedValue == nil || *events[0].DerivedValue != 1.683 {
		t.Fatalf("expected CPUs utilized derived value, got %+v", events[0].DerivedValue)
	}
	if events[0].DerivedUnit != "CPUs utilized" {
		t.Fatalf("expected CPUs utilized derived unit, got %q", events[0].DerivedUnit)
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

func TestResolvePerfDelaySubstitutesParams(t *testing.T) {
	step := plan.Step{PerfDelay: "{{WARMUP_SECS}}"}
	got, warning := resolvePerfDelay(step, []plan.Param{{Name: "WARMUP_SECS", Value: "10"}})
	if warning != "" {
		t.Fatalf("unexpected warning: %s", warning)
	}
	if got != 10 {
		t.Fatalf("expected 10, got %d", got)
	}
}

func TestResolvePerfDelayDefaultsEmptyToZero(t *testing.T) {
	got, warning := resolvePerfDelay(plan.Step{}, nil)
	if warning != "" {
		t.Fatalf("unexpected warning: %s", warning)
	}
	if got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}
}

func TestResolvePerfDelayForModeUsesModeSpecificValue(t *testing.T) {
	step := plan.Step{
		PerfDelay:       "1",
		PerfStatDelay:   "2",
		PerfRecordDelay: "{{RECORD_DELAY}}",
		PerfTraceDelay:  "4",
	}
	got, warning := resolvePerfDelayForMode(step, "record", []plan.Param{{Name: "RECORD_DELAY", Value: "3"}})
	if warning != "" {
		t.Fatalf("unexpected warning: %s", warning)
	}
	if got != 3 {
		t.Fatalf("expected 3, got %d", got)
	}
}

func TestResolvePerfDelayForModeFallsBackToLegacyValue(t *testing.T) {
	step := plan.Step{PerfDelay: "7"}
	got, warning := resolvePerfDelayForMode(step, "trace", nil)
	if warning != "" {
		t.Fatalf("unexpected warning: %s", warning)
	}
	if got != 7 {
		t.Fatalf("expected 7, got %d", got)
	}
}

func TestResolvePerfCgroupPrefersStepValue(t *testing.T) {
	opts := RunOpts{Plan: &plan.Plan{
		Params: []plan.Param{{Name: "CGROUP", Value: "system.slice/custom.slice"}},
		Server: plan.ServerConfig{PerfScope: "postgres_cgroup", PerfCgroup: "system.slice/postgresql.service"},
	}}
	got := resolvePerfCgroup(plan.Step{PerfCgroup: "{{CGROUP}}"}, opts)
	if got != "system.slice/custom.slice" {
		t.Fatalf("expected step cgroup, got %q", got)
	}
}

func TestResolvePerfCgroupFallsBackToServerPostgresCgroup(t *testing.T) {
	opts := RunOpts{Plan: &plan.Plan{
		Server: plan.ServerConfig{PerfScope: "postgres_cgroup", PerfCgroup: "system.slice/postgresql.service"},
	}}
	got := resolvePerfCgroup(plan.Step{}, opts)
	if got != "system.slice/postgresql.service" {
		t.Fatalf("expected server cgroup, got %q", got)
	}
}

func TestResolvePerfCgroupEmptyForSystemScope(t *testing.T) {
	opts := RunOpts{Plan: &plan.Plan{
		Server: plan.ServerConfig{PerfScope: "system", PerfCgroup: "system.slice/postgresql.service"},
	}}
	got := resolvePerfCgroup(plan.Step{}, opts)
	if got != "" {
		t.Fatalf("expected empty cgroup, got %q", got)
	}
}

func TestParsePerfTraceSummaryVPSFormat(t *testing.T) {
	out := `
 sleep (33806), 236 events, 81.4%

   syscall            calls  errors  total       min       avg       max       stddev
   --------------- --------  ------ -------- --------- --------- ---------     ------
   clock_nanosleep        1      0 2999.814  2999.814  2999.814  2999.814      0.00%
   mmap                  22      0    0.232     0.002     0.011     0.049     20.48%
`
	rows := parsePerfTraceSummary(out)
	if len(rows) != 2 {
		t.Fatalf("expected 2 syscall rows, got %d: %+v", len(rows), rows)
	}
	if rows[0].Process != "sleep" || rows[0].PID != 33806 {
		t.Fatalf("unexpected process metadata: %+v", rows[0])
	}
	if rows[0].Syscall != "clock_nanosleep" || rows[0].Calls != 1 || rows[0].Errors != 0 {
		t.Fatalf("unexpected first syscall row: %+v", rows[0])
	}
	if rows[0].TotalMs != 2999.814 || rows[0].MinMs != 2999.814 || rows[0].AvgMs != 2999.814 || rows[0].MaxMs != 2999.814 {
		t.Fatalf("unexpected first syscall timings: %+v", rows[0])
	}
	if rows[1].Syscall != "mmap" || rows[1].Calls != 22 || rows[1].TotalMs != 0.232 {
		t.Fatalf("unexpected second syscall row: %+v", rows[1])
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
