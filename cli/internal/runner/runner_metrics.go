package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khanh1998/mybench/cli/internal/result"
)

// runnerMinInterval is the floor for the sampling interval. Sub-second sampling adds
// no information for benchmark-scale analysis and only costs CPU on the runner.
const runnerMinInterval = time.Second

// runnerDefaultInterval is the sampling period (seconds) for runner-host metrics when the
// plan does not set proc_step.runner_interval_seconds.
const runnerDefaultInterval = 10

// LocalMetricsCollector samples the runner host's own /proc (the machine that executes
// pgbench/sysbench) so client-side saturation can be told apart from server-side waits.
//
// It reads /proc files directly with os.ReadFile — no SSH and no forked helper processes —
// so the observer effect stays in the microsecond range per tick. Rows go to
// runner_snap_* tables; the DB host's collector keeps writing host_snap_* tables.
type LocalMetricsCollector struct {
	mu        sync.Mutex
	snapshots map[string][]result.SnapshotRow
	config    map[string]any
	stopCh    chan struct{}
	doneCh    chan struct{}
	interval  time.Duration
	started   bool
	selfPID   int
	// scanChildren is set when /proc/<pid>/task/<tid>/children is unavailable
	// (kernel without CONFIG_PROC_CHILDREN) and descendants must be found by scanning /proc.
	scanChildren bool
}

// NewLocalMetricsCollector creates a collector but does NOT start sampling.
// Returns nil when /proc/stat is unreadable (non-Linux host).
func NewLocalMetricsCollector(intervalSecs int) *LocalMetricsCollector {
	if _, err := os.ReadFile("/proc/stat"); err != nil {
		fmt.Printf("warning: runner metrics: /proc/stat unreadable (%v) — runner metrics will not be collected\n", err)
		return nil
	}
	interval := time.Duration(intervalSecs) * time.Second
	if intervalSecs <= 0 {
		interval = 30 * time.Second
	}
	if interval < runnerMinInterval {
		interval = runnerMinInterval
	}
	return &LocalMetricsCollector{
		snapshots: make(map[string][]result.SnapshotRow),
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
		interval:  interval,
		selfPID:   os.Getpid(),
	}
}

// Start takes a t=0 sample immediately, then one per interval. Call once, just before the bench step.
func (c *LocalMetricsCollector) Start() {
	c.started = true
	go c.run()
}

// Stop takes a final sample so short benchmarks still yield a rate window, then returns
// everything collected. Safe to call when Start() was never called.
func (c *LocalMetricsCollector) Stop() (map[string][]result.SnapshotRow, map[string]any) {
	if c.started {
		close(c.stopCh)
		<-c.doneCh
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshots, c.config
}

func (c *LocalMetricsCollector) run() {
	defer close(c.doneCh)

	c.config = collectRunnerConfig()
	c.collectOnce()

	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stopCh:
			c.collectOnce()
			return
		case <-ticker.C:
			c.collectOnce()
		}
	}
}

func readProcFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func collectRunnerConfig() map[string]any {
	cfg := map[string]any{
		"nproc":   int64(runtime.NumCPU()),
		"clk_tck": int64(100), // USER_HZ is 100 on every Linux arch Ubuntu ships
	}
	if v := strings.TrimSpace(readProcFile("/proc/sys/kernel/osrelease")); v != "" {
		cfg["kernel"] = v
	}
	for _, line := range strings.Split(readProcFile("/proc/cpuinfo"), "\n") {
		if strings.HasPrefix(line, "model name") {
			if i := strings.Index(line, ":"); i >= 0 {
				cfg["cpu_model"] = strings.TrimSpace(line[i+1:])
			}
			break
		}
	}
	for _, line := range strings.Split(readProcFile("/proc/meminfo"), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				if v, err := strconv.ParseInt(f[1], 10, 64); err == nil {
					cfg["mem_total_kb"] = v
				}
			}
			break
		}
	}
	_, psiErr := os.Stat("/proc/pressure/cpu")
	cfg["psi_available"] = psiErr == nil
	return cfg
}

func (c *LocalMetricsCollector) collectOnce() {
	began := time.Now()
	ts := began.UTC().Format(time.RFC3339Nano)

	add := func(table string, row result.SnapshotRow) {
		if len(row) == 0 {
			return
		}
		row["_collected_at"] = ts
		c.mu.Lock()
		c.snapshots[table] = append(c.snapshots[table], row)
		c.mu.Unlock()
	}
	addAll := func(table string, rows []result.SnapshotRow) {
		for _, r := range rows {
			add(table, r)
		}
	}

	statText := readProcFile("/proc/stat")
	add("runner_snap_proc_stat", parseProcStat(statText))
	addAll("runner_snap_proc_stat_cpu", parseProcStatCPUs(statText))
	add("runner_snap_proc_loadavg", parseLoadavg(readProcFile("/proc/loadavg")))
	add("runner_snap_proc_meminfo", parseMeminfo(readProcFile("/proc/meminfo")))
	add("runner_snap_proc_psi", parsePsi(
		readProcFile("/proc/pressure/cpu"),
		readProcFile("/proc/pressure/memory"),
		readProcFile("/proc/pressure/io"),
	))
	addAll("runner_snap_proc_netdev", parseNetdev(readProcFile("/proc/net/dev")))
	add("runner_snap_proc_snmp", parseSnmpTCP(readProcFile("/proc/net/snmp")))

	threads := c.collectThreads(ts)
	for _, r := range threads {
		add("runner_snap_proc_thread", r)
	}

	// Self-measurement: how long this sample took, so the overhead is visible instead of assumed.
	add("runner_snap_collector", result.SnapshotRow{
		"sample_us": time.Since(began).Microseconds(),
		"threads":   int64(len(threads)),
	})
}

// parseProcStatCPUs returns one row per logical CPU (cpu0, cpu1, ...) from /proc/stat.
// The aggregate "cpu" line is handled by parseProcStat.
func parseProcStatCPUs(text string) []result.SnapshotRow {
	cols := []string{"cpu_user", "cpu_nice", "cpu_system", "cpu_idle",
		"cpu_iowait", "cpu_irq", "cpu_softirq", "cpu_steal", "cpu_guest", "cpu_guest_nice"}
	var rows []result.SnapshotRow
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || !strings.HasPrefix(fields[0], "cpu") || fields[0] == "cpu" {
			continue
		}
		row := result.SnapshotRow{"cpu_id": strings.TrimPrefix(fields[0], "cpu")}
		for i, col := range cols {
			if i+1 < len(fields) {
				if v, err := strconv.ParseInt(fields[i+1], 10, 64); err == nil {
					row[col] = v
				}
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// parseSnmpTCP extracts the TCP counters that reveal packet-level trouble
// (retransmits, resets, errors) from /proc/net/snmp. The file has paired lines:
// "Tcp: <names...>" followed by "Tcp: <values...>".
func parseSnmpTCP(text string) result.SnapshotRow {
	want := map[string]string{
		"RetransSegs":  "tcp_retrans_segs",
		"OutSegs":      "tcp_out_segs",
		"InSegs":       "tcp_in_segs",
		"InErrs":       "tcp_in_errs",
		"OutRsts":      "tcp_out_rsts",
		"AttemptFails": "tcp_attempt_fails",
		"EstabResets":  "tcp_estab_resets",
		"CurrEstab":    "tcp_curr_estab",
	}
	var names []string
	row := result.SnapshotRow{}
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "Tcp:") {
			continue
		}
		fields := strings.Fields(line)[1:]
		if names == nil {
			names = fields
			continue
		}
		for i, n := range names {
			col, ok := want[n]
			if !ok || i >= len(fields) {
				continue
			}
			if v, err := strconv.ParseInt(fields[i], 10, 64); err == nil {
				row[col] = v
			}
		}
		break
	}
	if len(row) == 0 {
		return nil
	}
	return row
}

// collectThreads samples every thread of mybench-runner and its descendants
// (pgbench / sysbench / psql). Per-thread data matters because pgbench can pin one
// core at 100% while the aggregate CPU still reads ~12% on an 8-core box.
func (c *LocalMetricsCollector) collectThreads(_ string) []result.SnapshotRow {
	var rows []result.SnapshotRow
	for _, pid := range c.discoverPIDs() {
		procName := strings.TrimSpace(readProcFile(fmt.Sprintf("/proc/%d/comm", pid)))
		if procName == "" {
			continue // exited between discovery and read
		}
		taskDir := fmt.Sprintf("/proc/%d/task", pid)
		entries, err := os.ReadDir(taskDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			tid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			base := filepath.Join(taskDir, e.Name())
			row := parseThreadStat(readProcFile(base+"/stat"), pid, tid)
			if row == nil {
				continue
			}
			row["proc"] = procName
			mergeSchedstat(row, readProcFile(base+"/schedstat"))
			mergeCtxSwitches(row, readProcFile(base+"/status"))
			rows = append(rows, row)
		}
	}
	return rows
}

// discoverPIDs returns this process plus all descendants.
func (c *LocalMetricsCollector) discoverPIDs() []int {
	pids := []int{c.selfPID}
	seen := map[int]bool{c.selfPID: true}

	if !c.scanChildren {
		for i := 0; i < len(pids); i++ {
			children, ok := readChildren(pids[i])
			if !ok {
				c.scanChildren = true
				break
			}
			for _, ch := range children {
				if !seen[ch] {
					seen[ch] = true
					pids = append(pids, ch)
				}
			}
		}
		if !c.scanChildren {
			return pids
		}
		pids, seen = []int{c.selfPID}, map[int]bool{c.selfPID: true}
	}

	// Fallback: build a ppid map by scanning /proc, then walk down from self.
	children := map[int][]int{}
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if ppid, ok := parsePPID(readProcFile(fmt.Sprintf("/proc/%d/stat", pid))); ok {
			children[ppid] = append(children[ppid], pid)
		}
	}
	for i := 0; i < len(pids); i++ {
		for _, ch := range children[pids[i]] {
			if !seen[ch] {
				seen[ch] = true
				pids = append(pids, ch)
			}
		}
	}
	return pids
}

// readChildren reads /proc/<pid>/task/*/children. ok=false means the kernel does not
// expose the file at all; a vanished process still returns ok=true with no children.
func readChildren(pid int) ([]int, bool) {
	taskDir := fmt.Sprintf("/proc/%d/task", pid)
	entries, err := os.ReadDir(taskDir)
	if err != nil {
		return nil, true
	}
	var out []int
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(taskDir, e.Name(), "children"))
		if err != nil {
			if os.IsNotExist(err) && pid == os.Getpid() {
				return nil, false
			}
			continue
		}
		for _, f := range strings.Fields(string(b)) {
			if v, err := strconv.Atoi(f); err == nil {
				out = append(out, v)
			}
		}
	}
	return out, true
}

func parsePPID(stat string) (int, bool) {
	end := strings.LastIndex(stat, ")")
	if end < 0 {
		return 0, false
	}
	f := strings.Fields(stat[end+1:])
	if len(f) < 2 {
		return 0, false
	}
	v, err := strconv.Atoi(f[1])
	return v, err == nil
}

// parseThreadStat parses /proc/<pid>/task/<tid>/stat.
// After the closing ")": f[0]=state(3) f[11]=utime(14) f[12]=stime(15) f[36]=processor(39).
func parseThreadStat(line string, pid, tid int) result.SnapshotRow {
	line = strings.TrimSpace(line)
	start, end := strings.Index(line, "("), strings.LastIndex(line, ")")
	if start < 0 || end <= start {
		return nil
	}
	f := strings.Fields(line[end+1:])
	if len(f) < 13 {
		return nil
	}
	row := result.SnapshotRow{
		"pid":   int64(pid),
		"tid":   int64(tid),
		"comm":  line[start+1 : end],
		"state": f[0],
	}
	for idx, col := range map[int]string{11: "utime", 12: "stime", 36: "processor"} {
		if idx < len(f) {
			if v, err := strconv.ParseInt(f[idx], 10, 64); err == nil {
				row[col] = v
			}
		}
	}
	return row
}

// mergeSchedstat adds run-queue wait time: the time a thread was runnable but not on a CPU.
// A thread that waits a lot while the host looks idle is being starved of cores.
func mergeSchedstat(row result.SnapshotRow, text string) {
	f := strings.Fields(text)
	if len(f) < 3 {
		return
	}
	for i, col := range []string{"run_time_ns", "wait_time_ns", "timeslices"} {
		if v, err := strconv.ParseInt(f[i], 10, 64); err == nil {
			row[col] = v
		}
	}
}

func mergeCtxSwitches(row result.SnapshotRow, status string) {
	for _, line := range strings.Split(status, "\n") {
		switch {
		case strings.HasPrefix(line, "voluntary_ctxt_switches:"):
			if v, err := strconv.ParseInt(strings.TrimSpace(line[len("voluntary_ctxt_switches:"):]), 10, 64); err == nil {
				row["vol_ctxt_sw"] = v
			}
		case strings.HasPrefix(line, "nonvoluntary_ctxt_switches:"):
			if v, err := strconv.ParseInt(strings.TrimSpace(line[len("nonvoluntary_ctxt_switches:"):]), 10, 64); err == nil {
				row["nvol_ctxt_sw"] = v
			}
		}
	}
}
