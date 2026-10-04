package runner

import (
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/khanh1998/mybench/cli/internal/result"
)

func TestParseProcStatCPUs(t *testing.T) {
	text := "cpu  100 0 50 800 5 0 1 2 0 0\n" +
		"cpu0 60 0 30 400 3 0 1 1 0 0\n" +
		"cpu1 40 0 20 400 2 0 0 1 0 0\n" +
		"intr 12345 1 2\n"
	rows := parseProcStatCPUs(text)
	if len(rows) != 2 {
		t.Fatalf("want 2 per-cpu rows (aggregate excluded), got %d", len(rows))
	}
	if rows[0]["cpu_id"] != "0" || rows[1]["cpu_id"] != "1" {
		t.Errorf("cpu_id = %v, %v", rows[0]["cpu_id"], rows[1]["cpu_id"])
	}
	if rows[0]["cpu_user"] != int64(60) || rows[0]["cpu_steal"] != int64(1) {
		t.Errorf("cpu0 = %v", rows[0])
	}
}

func TestParseSnmpTCP(t *testing.T) {
	text := "Ip: Forwarding DefaultTTL\nIp: 1 64\n" +
		"Tcp: RtoAlgorithm ActiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts\n" +
		"Tcp: 1 10 2 3 40 5000 6000 77 1 9\n"
	row := parseSnmpTCP(text)
	want := map[string]int64{
		"tcp_attempt_fails": 2, "tcp_estab_resets": 3, "tcp_curr_estab": 40,
		"tcp_in_segs": 5000, "tcp_out_segs": 6000, "tcp_retrans_segs": 77,
		"tcp_in_errs": 1, "tcp_out_rsts": 9,
	}
	for k, v := range want {
		if row[k] != v {
			t.Errorf("%s = %v, want %d", k, row[k], v)
		}
	}
	if parseSnmpTCP("Ip: a b\nIp: 1 2\n") != nil {
		t.Error("expected nil when no Tcp section")
	}
}

func TestParseThreadStat(t *testing.T) {
	// comm contains spaces and a ")" to exercise the last-paren rule.
	// Fields after ")": state=3 ... utime=14 stime=15 ... processor=39.
	line := "4242 (pg bench)) R 1 4242 4242 0 -1 4194304 100 0 0 0 1234 567 0 0 20 0 8 0 100 1000 200 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0"
	row := parseThreadStat(line, 4200, 4242)
	if row == nil {
		t.Fatal("nil row")
	}
	if row["comm"] != "pg bench)" || row["state"] != "R" {
		t.Errorf("comm/state = %v / %v", row["comm"], row["state"])
	}
	if row["utime"] != int64(1234) || row["stime"] != int64(567) {
		t.Errorf("utime/stime = %v / %v", row["utime"], row["stime"])
	}
	if row["processor"] != int64(3) {
		t.Errorf("processor = %v", row["processor"])
	}
	if row["pid"] != int64(4200) || row["tid"] != int64(4242) {
		t.Errorf("pid/tid = %v / %v", row["pid"], row["tid"])
	}
	if parseThreadStat("garbage", 1, 1) != nil {
		t.Error("expected nil for malformed stat")
	}
}

func TestMergeSchedstatAndCtxSwitches(t *testing.T) {
	row := map[string]any{}
	mergeSchedstat(row, "9000000 3000000 42\n")
	if row["run_time_ns"] != int64(9000000) || row["wait_time_ns"] != int64(3000000) || row["timeslices"] != int64(42) {
		t.Errorf("schedstat = %v", row)
	}
	mergeCtxSwitches(row, "Name:\tpgbench\nvoluntary_ctxt_switches:\t11\nnonvoluntary_ctxt_switches:\t7\n")
	if row["vol_ctxt_sw"] != int64(11) || row["nvol_ctxt_sw"] != int64(7) {
		t.Errorf("ctx = %v", row)
	}
}

func TestParsePPID(t *testing.T) {
	if v, ok := parsePPID("12 (a b) S 99 12 12 0"); !ok || v != 99 {
		t.Errorf("ppid = %d ok=%v", v, ok)
	}
	if _, ok := parsePPID("nonsense"); ok {
		t.Error("expected !ok")
	}
}

// TestLocalMetricsCollectorLive exercises the collector against the real /proc.
// It spawns a CPU-burning child and checks the child's threads are discovered
// with advancing CPU time. Skipped where /proc is unavailable (non-Linux).
func TestLocalMetricsCollectorLive(t *testing.T) {
	if _, err := os.Stat("/proc/stat"); err != nil {
		t.Skip("no /proc on this platform")
	}
	child := exec.Command("sh", "-c", "while :; do :; done")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()

	c := NewLocalMetricsCollector(1)
	if c == nil {
		t.Fatal("collector is nil on a host with /proc")
	}
	c.Start()
	time.Sleep(2500 * time.Millisecond)
	snaps, cfg := c.Stop()

	if n := len(snaps["runner_snap_proc_stat"]); n < 2 {
		t.Errorf("proc_stat samples = %d, want >= 2", n)
	}
	if len(snaps["runner_snap_proc_stat_cpu"]) < 2 {
		t.Errorf("per-cpu rows = %d", len(snaps["runner_snap_proc_stat_cpu"]))
	}
	if len(snaps["runner_snap_proc_loadavg"]) == 0 || len(snaps["runner_snap_proc_meminfo"]) == 0 {
		t.Error("missing loadavg/meminfo rows")
	}
	if len(snaps["runner_snap_proc_snmp"]) == 0 {
		t.Error("missing /proc/net/snmp row")
	}
	col := snaps["runner_snap_collector"]
	if len(col) < 2 {
		t.Fatalf("collector rows = %d", len(col))
	}
	if us, _ := col[0]["sample_us"].(int64); us <= 0 {
		t.Errorf("sample_us = %v", col[0]["sample_us"])
	} else {
		t.Logf("sample took %dµs, %v threads", us, col[0]["threads"])
	}

	// Child shell must be discovered (as a descendant of this test process) with growing CPU time.
	var first, last int64 = -1, -1
	selfSeen := false
	for _, r := range snaps["runner_snap_proc_thread"] {
		if r["pid"] == int64(child.Process.Pid) {
			if r["proc"] != "sh" {
				t.Errorf("child proc name = %v", r["proc"])
			}
			u := r["utime"].(int64) + r["stime"].(int64)
			if first < 0 {
				first = u
			}
			last = u
		}
		if r["pid"] == int64(os.Getpid()) {
			selfSeen = true
		}
	}
	if first < 0 {
		t.Fatal("child process threads were not discovered")
	}
	if last <= first {
		t.Errorf("child CPU did not advance: %d -> %d jiffies", first, last)
	}
	if !selfSeen {
		t.Error("collector's own process not sampled")
	}

	if cfg["nproc"] == nil || cfg["kernel"] == nil || cfg["mem_total_kb"] == nil {
		t.Errorf("incomplete runner config: %v", cfg)
	}
}

// TestDiscoverPIDsScanFallback checks the /proc scan used when the children files are missing.
func TestDiscoverPIDsScanFallback(t *testing.T) {
	if _, err := os.Stat("/proc/stat"); err != nil {
		t.Skip("no /proc on this platform")
	}
	child := exec.Command("sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()

	c := NewLocalMetricsCollector(1)
	c.scanChildren = true
	found := false
	for _, pid := range c.discoverPIDs() {
		if pid == child.Process.Pid {
			found = true
		}
	}
	if !found {
		t.Error("scan fallback did not find the child")
	}
	c.scanChildren = false
	found = false
	for _, pid := range c.discoverPIDs() {
		if pid == child.Process.Pid {
			found = true
		}
	}
	if !found {
		t.Error("children-file discovery did not find the child")
	}
}

// BenchmarkCollectOnce measures the steady-state cost of one sampling pass.
// Run on Linux: go test ./internal/runner -run '^$' -bench CollectOnce
func BenchmarkCollectOnce(b *testing.B) {
	if _, err := os.Stat("/proc/stat"); err != nil {
		b.Skip("no /proc on this platform")
	}
	c := NewLocalMetricsCollector(1)
	c.collectOnce() // warm caches
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c.collectOnce()
		c.mu.Lock()
		c.snapshots = make(map[string][]result.SnapshotRow) // keep memory flat across iterations
		c.mu.Unlock()
	}
}
