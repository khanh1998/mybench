package runner

import (
	"strings"
	"testing"
)

func TestBuildCollectionScriptAllGroups(t *testing.T) {
	s := buildCollectionScript(nil)
	for _, want := range []string{
		"/proc/loadavg", "/proc/meminfo", "/proc/stat", "/proc/vmstat", "/proc/diskstats",
		"/proc/net/dev", "/proc/schedstat", "/proc/pressure/cpu", "/proc/pressure/memory",
		"/proc/pressure/io", "/proc/sys/fs/file-nr", "pgrep -x postgres",
		"/proc/$p/cmdline", "/proc/$p/stat", "/proc/$p/statm", "/proc/$p/io",
		"/proc/$p/schedstat", "/proc/$p/wchan", "/proc/$p/status", "fd_count", "exit 0",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("all-groups script missing %q", want)
		}
	}
}

func TestBuildCollectionScriptSelectedGroups(t *testing.T) {
	s := buildCollectionScript(map[string]bool{"stat": true, "pressure": true, "pid_schedstat": true})
	for _, want := range []string{"/proc/stat", "/proc/pressure/io", "/proc/$p/schedstat", "pgrep -x postgres"} {
		if !strings.Contains(s, want) {
			t.Errorf("script missing %q", want)
		}
	}
	for _, unwanted := range []string{"/proc/meminfo", "/proc/vmstat", "/proc/schedstat", "cmdline", "/proc/$p/stat ", "status", "fd"} {
		if strings.Contains(s, unwanted) {
			t.Errorf("script should not contain %q:\n%s", unwanted, s)
		}
	}
}

func TestBuildCollectionScriptNoPidGroups(t *testing.T) {
	s := buildCollectionScript(map[string]bool{"loadavg": true})
	if strings.Contains(s, "pgrep") {
		t.Errorf("script without pid groups should not list postgres PIDs:\n%s", s)
	}
}

func TestParseCollectionOutput(t *testing.T) {
	out := strings.Join([]string{
		"/proc/loadavg:0.50 0.40 0.30 2/300 1234",
		"/proc/stat:cpu  1 2 3 4",
		"/proc/stat:cpu0 1 2 3 4",
		"/proc/net/dev:Inter-|   Receive",
		"/proc/pressure/cpu:some avg10=0.00 avg60=0.00 avg300=0.00 total=1",
		"/proc/123/cmdline:postgres: mybench db 10.0.0.1(5555) idle\x00",
		"/proc/123/stat:123 (postgres) S 1 123 123 0 -1",
		"/proc/123/schedstat:100 200 3",
		"/proc/123/status:Name:\tpostgres",
		"/proc/123/status:VmRSS:\t   1024 kB",
		"/proc/123/fd_count:17",
		"/proc/self/stat:ignored",
		"grep: /proc/999/stat: No such file or directory",
		"",
	}, "\n")
	sec := parseCollectionOutput(out)
	want := map[string]string{
		"loadavg":           "0.50 0.40 0.30 2/300 1234",
		"stat":              "cpu  1 2 3 4\ncpu0 1 2 3 4",
		"netdev":            "Inter-|   Receive",
		"psi_cpu":           "some avg10=0.00 avg60=0.00 avg300=0.00 total=1",
		"pid_cmdline:123":   "postgres: mybench db 10.0.0.1(5555) idle\x00",
		"pid_stat:123":      "123 (postgres) S 1 123 123 0 -1",
		"pid_schedstat:123": "100 200 3",
		"pid_status:123":    "Name:\tpostgres\nVmRSS:\t   1024 kB",
		"pid_fd_count:123":  "17",
	}
	for k, v := range want {
		if sec[k] != v {
			t.Errorf("section %q = %q, want %q", k, sec[k], v)
		}
	}
	if len(sec) != len(want) {
		t.Errorf("got %d sections, want %d: %v", len(sec), len(want), sec)
	}
	if row := parsePidStatus(sec["pid_status:123"], 123); row["vm_rss_kb"] != int64(1024) {
		t.Errorf("parsePidStatus on grep output: %v", row)
	}
	if got := parsePidCmdline(sec["pid_cmdline:123"]); got != "postgres: mybench db 10.0.0.1(5555) idle" {
		t.Errorf("parsePidCmdline = %q", got)
	}
}
