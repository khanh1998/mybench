package runner

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
	"golang.org/x/crypto/ssh"
)

// hostFiles lists, per host-wide proc group, the files it reads and the section
// name collectOnce looks them up under.
var hostFiles = []struct {
	group, section, path string
}{
	{"loadavg", "loadavg", "/proc/loadavg"},
	{"meminfo", "meminfo", "/proc/meminfo"},
	{"stat", "stat", "/proc/stat"},
	{"vmstat", "proc_vmstat", "/proc/vmstat"},
	{"diskstats", "diskstats", "/proc/diskstats"},
	{"net_dev", "netdev", "/proc/net/dev"},
	{"schedstat", "schedstat", "/proc/schedstat"},
	{"pressure", "psi_cpu", "/proc/pressure/cpu"},
	{"pressure", "psi_memory", "/proc/pressure/memory"},
	{"pressure", "psi_io", "/proc/pressure/io"},
	{"file_nr", "file_nr", "/proc/sys/fs/file-nr"},
}

// pidFiles lists, per per-PID group, the /proc/<pid>/ files it reads. The
// section name is "pid_<file>:<pid>". cmdline only labels pid_stat rows.
var pidFiles = []struct {
	group string
	files []string
}{
	{"pid_stat", []string{"cmdline", "stat"}},
	{"pid_statm", []string{"statm"}},
	{"pid_io", []string{"io"}},
	{"pid_schedstat", []string{"schedstat"}},
	{"pid_wchan", []string{"wchan"}},
}

const pidStatusPattern = "^(Name|State|FDSize|Threads|VmPeak|VmSize|VmRSS|RssAnon|RssFile|RssShmem|VmSwap|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):"

// buildCollectionScript returns a script that reads the proc files of the
// selected groups (nil = all) in one SSH round trip.
//
// Every process the script starts costs ~1 ms of CPU on the DB host, and a
// cat per file per postgres PID adds up to ~130 processes per sample under
// load (≈5–8% TPS on a 4-vCPU server at a 1s interval). So each file set is
// read by a single `grep -aH ''`, which prefixes every line with its path;
// parseCollectionOutput splits the output back into sections. The fd count
// uses a shell glob, so it starts no process at all.
func buildCollectionScript(groups map[string]bool) string {
	want := func(g string) bool { return groups == nil || groups[g] }
	var b strings.Builder

	var hostPaths []string
	for _, f := range hostFiles {
		if want(f.group) {
			hostPaths = append(hostPaths, f.path)
		}
	}
	if len(hostPaths) > 0 {
		fmt.Fprintf(&b, "grep -aH '' %s 2>/dev/null\n", strings.Join(hostPaths, " "))
	}

	var perPid []string
	for _, f := range pidFiles {
		if want(f.group) {
			perPid = append(perPid, f.files...)
		}
	}
	status, fd := want("pid_status"), want("pid_fd")
	if len(perPid) > 0 || status || fd {
		b.WriteString("pids=$(pgrep -x postgres 2>/dev/null)\n")
	}
	if len(perPid) > 0 {
		b.WriteString("f=''\nfor p in $pids; do f=\"$f")
		for _, name := range perPid {
			b.WriteString(" /proc/$p/" + name)
		}
		b.WriteString("\"; done\n[ -n \"$f\" ] && grep -aH '' $f 2>/dev/null\n")
	}
	if status {
		b.WriteString("f=''\nfor p in $pids; do f=\"$f /proc/$p/status\"; done\n")
		fmt.Fprintf(&b, "[ -n \"$f\" ] && grep -aHE '%s' $f 2>/dev/null\n", pidStatusPattern)
	}
	if fd {
		b.WriteString("for p in $pids; do set -- /proc/$p/fd/*; [ -e \"$1\" ] && echo \"/proc/$p/fd_count:$#\"; done\n")
	}
	// grep exits non-zero when a PID vanished mid-sample; that is not a failure.
	b.WriteString("exit 0\n")
	return b.String()
}

// hostSectionByPath maps a host-wide proc path to its section name.
var hostSectionByPath = func() map[string]string {
	m := make(map[string]string, len(hostFiles))
	for _, f := range hostFiles {
		m[f.path] = f.section
	}
	return m
}()

// parseCollectionOutput groups the "path:line" output of buildCollectionScript
// into sections keyed like "stat" or "pid_schedstat:<pid>".
func parseCollectionOutput(output string) map[string]string {
	bufs := make(map[string]*strings.Builder)
	var order []string
	for _, line := range strings.Split(output, "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		path, content := line[:i], line[i+1:]
		key, ok := hostSectionByPath[path]
		if !ok {
			// /proc/<pid>/<file>
			rest, found := strings.CutPrefix(path, "/proc/")
			if !found {
				continue
			}
			pid, file, found := strings.Cut(rest, "/")
			if !found || pid == "" || strings.Trim(pid, "0123456789") != "" {
				continue
			}
			key = "pid_" + file + ":" + pid
		}
		buf := bufs[key]
		if buf == nil {
			buf = &strings.Builder{}
			bufs[key] = buf
			order = append(order, key)
		}
		buf.WriteString(content)
		buf.WriteByte('\n')
	}
	sections := make(map[string]string, len(order))
	for _, k := range order {
		sections[k] = strings.TrimSpace(bufs[k].String())
	}
	return sections
}

const configScript = `
echo "nproc=$(nproc 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "cpu_model=$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | sed 's/^ *//')"
echo "mem_total_kb=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')"
echo "swap_total_kb=$(grep SwapTotal /proc/meminfo 2>/dev/null | awk '{print $2}')"
echo "file_max=$(cat /proc/sys/fs/file-max 2>/dev/null)"
echo "overcommit_memory=$(cat /proc/sys/vm/overcommit_memory 2>/dev/null)"
echo "swappiness=$(cat /proc/sys/vm/swappiness 2>/dev/null)"
echo "dirty_ratio=$(cat /proc/sys/vm/dirty_ratio 2>/dev/null)"
echo "dirty_background_ratio=$(cat /proc/sys/vm/dirty_background_ratio 2>/dev/null)"
echo "hugepagesize_kb=$(grep Hugepagesize /proc/meminfo 2>/dev/null | awk '{print $2}')"
`

// HostMetricsCollector collects OS metrics from a remote host via SSH.
// Metrics are stored in host_snap_* timeseries tables (one row per tick per table).
type HostMetricsCollector struct {
	mu         sync.Mutex
	snapshots  map[string][]result.SnapshotRow
	hostConfig map[string]any
	client     *ssh.Client
	stopCh     chan struct{}
	doneCh     chan struct{}
	interval   time.Duration
	started    bool
	groups     map[string]bool // nil = all groups
	script     string          // collection script for the selected groups
}

// NewHostMetricsCollector creates a host metrics collector but does NOT start collection.
// Call Start() to begin — typically just before the bench step so ticks align with bench start.
// groups is the list of metric groups to collect; nil or empty means all groups.
// Returns nil if SSH is not configured or the connection fails.
func NewHostMetricsCollector(srv plan.ServerConfig, intervalSecs int, groups []string) *HostMetricsCollector {
	if !srv.SSHEnabled || srv.SSHUser == "" || srv.SSHPrivateKey == "" {
		fmt.Printf("warning: proc step: SSH not configured on database server — host metrics will not be collected\n")
		return nil
	}
	if intervalSecs <= 0 {
		intervalSecs = 30
	}

	signer, err := ssh.ParsePrivateKey([]byte(srv.SSHPrivateKey))
	if err != nil {
		fmt.Printf("warning: host_metrics: parse SSH key: %v\n", err)
		return nil
	}

	sshHost := srv.SSHHost
	if sshHost == "" {
		sshHost = srv.Host
	}
	sshPort := srv.SSHPort
	if sshPort == 0 {
		sshPort = 22
	}
	addr := net.JoinHostPort(sshHost, strconv.Itoa(sshPort))

	cfg := &ssh.ClientConfig{
		User:            srv.SSHUser,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec — internal tooling
		Timeout:         15 * time.Second,
	}

	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		fmt.Printf("warning: host_metrics: SSH connect to %s: %v\n", addr, err)
		return nil
	}

	var groupsMap map[string]bool
	if len(groups) > 0 {
		groupsMap = make(map[string]bool, len(groups))
		for _, g := range groups {
			groupsMap[g] = true
		}
	}

	c := &HostMetricsCollector{
		snapshots: make(map[string][]result.SnapshotRow),
		client:    client,
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
		interval:  time.Duration(intervalSecs) * time.Second,
		groups:    groupsMap,
		script:    buildCollectionScript(groupsMap),
	}
	return c
}

// Start begins collection immediately (t=0 snapshot) then ticks every interval.
// Call exactly once, just before the bench step begins.
func (c *HostMetricsCollector) Start() {
	c.started = true
	go c.run()
}

// Stop signals the collector to finish and returns all collected snapshots and config.
// Safe to call even if Start() was never called (returns empty results).
func (c *HostMetricsCollector) Stop() (map[string][]result.SnapshotRow, map[string]any) {
	if c.started {
		close(c.stopCh)
		<-c.doneCh
	}
	c.client.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshots, c.hostConfig
}

func (c *HostMetricsCollector) run() {
	defer close(c.doneCh)

	// Collect one-time config and first snapshot immediately.
	c.hostConfig = c.collectConfig()
	c.collectOnce()

	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.collectOnce()
		}
	}
}

func (c *HostMetricsCollector) runCommand(cmd string) (string, error) {
	sess, err := c.client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	out, err := sess.Output(cmd)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (c *HostMetricsCollector) collectConfig() map[string]any {
	out, err := c.runCommand(configScript)
	if err != nil {
		return nil
	}
	cfg := make(map[string]any)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		eqIdx := strings.Index(line, "=")
		if eqIdx < 0 {
			continue
		}
		key := line[:eqIdx]
		val := strings.TrimSpace(line[eqIdx+1:])
		if v, err := strconv.ParseInt(val, 10, 64); err == nil {
			cfg[key] = v
		} else {
			cfg[key] = val
		}
	}
	return cfg
}

// shouldCollect returns true if the given group should be collected.
// When c.groups is nil (all groups), always returns true.
func (c *HostMetricsCollector) shouldCollect(group string) bool {
	if c.groups == nil {
		return true
	}
	return c.groups[group]
}

func (c *HostMetricsCollector) collectOnce() {
	ts := time.Now().UTC().Format(time.RFC3339Nano)
	out, err := c.runCommand(c.script)
	if err != nil {
		fmt.Printf("warning: host_metrics: collect: %v\n", err)
		return
	}
	sections := parseCollectionOutput(out)

	addRow := func(tableName string, row result.SnapshotRow) {
		if len(row) == 0 {
			return
		}
		row["_collected_at"] = ts
		c.mu.Lock()
		c.snapshots[tableName] = append(c.snapshots[tableName], row)
		c.mu.Unlock()
	}

	addRows := func(tableName string, rows []result.SnapshotRow) {
		for _, row := range rows {
			if len(row) == 0 {
				continue
			}
			row["_collected_at"] = ts
			c.mu.Lock()
			c.snapshots[tableName] = append(c.snapshots[tableName], row)
			c.mu.Unlock()
		}
	}

	if c.shouldCollect("loadavg") {
		if text, ok := sections["loadavg"]; ok {
			if row := parseLoadavg(text); row != nil {
				addRow("host_snap_proc_loadavg", row)
			}
		}
	}
	if c.shouldCollect("meminfo") {
		if text, ok := sections["meminfo"]; ok {
			if row := parseMeminfo(text); row != nil {
				addRow("host_snap_proc_meminfo", row)
			}
		}
	}
	if c.shouldCollect("stat") {
		if text, ok := sections["stat"]; ok {
			if row := parseProcStat(text); row != nil {
				addRow("host_snap_proc_stat", row)
			}
			// Per-core jiffies: a single core saturated by NIC softirq (single-queue
			// virtio) is invisible in the aggregate row.
			addRows("host_snap_proc_stat_cpu", parseProcStatCPUs(text))
		}
	}
	if c.shouldCollect("vmstat") {
		if text, ok := sections["proc_vmstat"]; ok {
			if row := parseProcVmstat(text); row != nil {
				addRow("host_snap_proc_vmstat", row)
			}
		}
	}
	if c.shouldCollect("diskstats") {
		if text, ok := sections["diskstats"]; ok {
			addRows("host_snap_proc_diskstats", parseDiskstats(text))
		}
	}
	if c.shouldCollect("net_dev") {
		if text, ok := sections["netdev"]; ok {
			addRows("host_snap_proc_netdev", parseNetdev(text))
		}
	}
	if c.shouldCollect("schedstat") {
		if text, ok := sections["schedstat"]; ok {
			addRows("host_snap_proc_schedstat", parseSchedstat(text))
		}
	}
	if c.shouldCollect("pressure") {
		cpuText := sections["psi_cpu"]
		memText := sections["psi_memory"]
		ioText := sections["psi_io"]
		if cpuText != "" || memText != "" || ioText != "" {
			if row := parsePsi(cpuText, memText, ioText); row != nil {
				addRow("host_snap_proc_psi", row)
			}
		}
	}
	if c.shouldCollect("file_nr") {
		if text, ok := sections["file_nr"]; ok {
			if row := parseFileNr(text); row != nil {
				addRow("host_snap_proc_sys_fs_file_nr", row)
			}
		}
	}

	// Per-PID collection: build cmdline map once if any pid_* group is enabled.
	collectPidStat := c.shouldCollect("pid_stat")
	collectPidStatm := c.shouldCollect("pid_statm")
	collectPidIO := c.shouldCollect("pid_io")
	collectPidSchedstat := c.shouldCollect("pid_schedstat")
	collectPidWchan := c.shouldCollect("pid_wchan")
	collectPidFd := c.shouldCollect("pid_fd")
	collectPidStatus := c.shouldCollect("pid_status")

	if collectPidStat || collectPidStatm || collectPidIO || collectPidSchedstat || collectPidWchan || collectPidFd || collectPidStatus {
		// Build cmdline map first so pid_stat rows can include it.
		cmdlineMap := make(map[int]string)
		for key, text := range sections {
			if strings.HasPrefix(key, "pid_cmdline:") {
				pidStr := key[len("pid_cmdline:"):]
				if pid, err := strconv.Atoi(pidStr); err == nil {
					if cl := parsePidCmdline(text); cl != "" {
						cmdlineMap[pid] = cl
					}
				}
			}
		}

		for key, text := range sections {
			for _, prefix := range []string{"pid_stat:", "pid_statm:", "pid_io:", "pid_schedstat:", "pid_wchan:", "pid_fd_count:", "pid_status:"} {
				if !strings.HasPrefix(key, prefix) {
					continue
				}
				pidStr := key[len(prefix):]
				pid, err := strconv.Atoi(pidStr)
				if err != nil {
					break
				}
				sectionType := strings.TrimSuffix(prefix, ":")
				switch sectionType {
				case "pid_stat":
					if collectPidStat {
						if row := parsePidStat(text, pid); row != nil {
							row["cmdline"] = cmdlineMap[pid]
							addRow("host_snap_proc_pid_stat", row)
						}
					}
				case "pid_statm":
					if collectPidStatm {
						if row := parsePidStatm(text, pid); row != nil {
							addRow("host_snap_proc_pid_statm", row)
						}
					}
				case "pid_io":
					if collectPidIO {
						if row := parsePidIO(text, pid); row != nil {
							addRow("host_snap_proc_pid_io", row)
						}
					}
				case "pid_schedstat":
					if collectPidSchedstat {
						if row := parsePidSchedstat(text, pid); row != nil {
							addRow("host_snap_proc_pid_schedstat", row)
						}
					}
				case "pid_wchan":
					if collectPidWchan {
						if row := parsePidWchan(text, pid); row != nil {
							addRow("host_snap_proc_pid_wchan", row)
						}
					}
				case "pid_fd_count":
					if collectPidFd {
						if row := parsePidFdCount(text, pid); row != nil {
							addRow("host_snap_proc_pid_fd_count", row)
						}
					}
				case "pid_status":
					if collectPidStatus {
						if row := parsePidStatus(text, pid); row != nil {
							addRow("host_snap_proc_pid_status", row)
						}
					}
				}
				break
			}
		}
	}
}

// --- Parsers ---


func parseLoadavg(text string) result.SnapshotRow {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) < 4 {
		return nil
	}
	row := result.SnapshotRow{}
	if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
		row["load1"] = v
	}
	if v, err := strconv.ParseFloat(fields[1], 64); err == nil {
		row["load5"] = v
	}
	if v, err := strconv.ParseFloat(fields[2], 64); err == nil {
		row["load15"] = v
	}
	parts := strings.SplitN(fields[3], "/", 2)
	if len(parts) == 2 {
		if v, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
			row["running_threads"] = v
		}
		if v, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
			row["total_threads"] = v
		}
	}
	return row
}

func parseMeminfo(text string) result.SnapshotRow {
	// Map /proc/meminfo field names → SQL-safe column names.
	colMap := map[string]string{
		"MemTotal": "mem_total", "MemFree": "mem_free", "MemAvailable": "mem_available",
		"Buffers": "buffers", "Cached": "cached", "SwapCached": "swap_cached",
		"Active": "active", "Inactive": "inactive",
		"Active(anon)": "active_anon", "Inactive(anon)": "inactive_anon",
		"Active(file)": "active_file", "Inactive(file)": "inactive_file",
		"Unevictable": "unevictable", "Mlocked": "mlocked",
		"SwapTotal": "swap_total", "SwapFree": "swap_free",
		"Zswap": "zswap", "Zswapped": "zswapped",
		"Dirty": "dirty", "Writeback": "writeback",
		"AnonPages": "anon_pages", "Mapped": "mapped", "Shmem": "shmem",
		"KReclaimable": "kreclaimable", "Slab": "slab",
		"SReclaimable": "sreclaimable", "SUnreclaim": "sunreclaim",
		"KernelStack": "kernel_stack", "PageTables": "page_tables",
		"SecPageTables": "sec_page_tables",
		"NFS_Unstable":  "nfs_unstable", "Bounce": "bounce", "WritebackTmp": "writeback_tmp",
		"CommitLimit": "commit_limit", "Committed_AS": "committed_as",
		"VmallocTotal": "vmalloc_total", "VmallocUsed": "vmalloc_used", "VmallocChunk": "vmalloc_chunk",
		"Percpu": "percpu", "HardwareCorrupted": "hardware_corrupted",
		"AnonHugePages":  "anon_huge_pages",
		"ShmemHugePages": "shmem_huge_pages", "ShmemPmdMapped": "shmem_pmd_mapped",
		"FileHugePages": "file_huge_pages", "FilePmdMapped": "file_pmd_mapped",
		"Unaccepted":      "unaccepted",
		"HugePages_Total": "hugepages_total", "HugePages_Free": "hugepages_free",
		"HugePages_Rsvd": "hugepages_rsvd", "HugePages_Surp": "hugepages_surp",
		"Hugepagesize": "hugepagesize", "Hugetlb": "hugetlb",
		"DirectMap4k": "direct_map4k", "DirectMap2M": "direct_map2m",
		"DirectMap1G": "direct_map1g",
	}

	row := result.SnapshotRow{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colonIdx])
		col, ok := colMap[key]
		if !ok {
			continue
		}
		valStr := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line[colonIdx+1:]), "kB"))
		if v, err := strconv.ParseInt(strings.TrimSpace(valStr), 10, 64); err == nil {
			row[col] = v
		}
	}
	if len(row) == 0 {
		return nil
	}
	return row
}

func parseProcStat(text string) result.SnapshotRow {
	row := result.SnapshotRow{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "cpu":
			// cpu user nice system idle iowait irq softirq steal guest guest_nice
			cols := []string{"cpu_user", "cpu_nice", "cpu_system", "cpu_idle",
				"cpu_iowait", "cpu_irq", "cpu_softirq", "cpu_steal", "cpu_guest", "cpu_guest_nice"}
			for i, col := range cols {
				if i+1 < len(fields) {
					if v, err := strconv.ParseInt(fields[i+1], 10, 64); err == nil {
						row[col] = v
					}
				}
			}
		case "intr":
			// First number after "intr" is the total interrupt count.
			if len(fields) >= 2 {
				if v, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
					row["intr"] = v
				}
			}
		case "ctxt", "processes", "procs_running", "procs_blocked":
			if len(fields) >= 2 {
				if v, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
					row[fields[0]] = v
				}
			}
		}
	}
	if len(row) == 0 {
		return nil
	}
	return row
}

// parseProcVmstat collects all key-value pairs from /proc/vmstat.
func parseProcVmstat(text string) result.SnapshotRow {
	row := result.SnapshotRow{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		if v, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
			row[fields[0]] = v
		}
	}
	if len(row) == 0 {
		return nil
	}
	return row
}

func parseDiskstats(text string) []result.SnapshotRow {
	var rows []result.SnapshotRow
	// Fields 1-17 (after major/minor/name):
	colNames := []string{
		"rd_ios", "rd_merges", "rd_sectors", "rd_ticks",
		"wr_ios", "wr_merges", "wr_sectors", "wr_ticks",
		"in_flight", "io_ticks", "time_in_queue",
		"dc_ios", "dc_merges", "dc_sectors", "dc_ticks",
		"fl_ios", "fl_ticks",
	}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 5 {
			continue
		}
		major, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		if major == 7 { // skip loop devices
			continue
		}
		device := fields[2]
		row := result.SnapshotRow{"device": device}
		for i, col := range colNames {
			fieldIdx := i + 3
			if fieldIdx >= len(fields) {
				break
			}
			if v, err := strconv.ParseInt(fields[fieldIdx], 10, 64); err == nil {
				row[col] = v
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func parseNetdev(text string) []result.SnapshotRow {
	colNames := []string{
		"rx_bytes", "rx_packets", "rx_errs", "rx_drop",
		"rx_fifo", "rx_frame", "rx_compressed", "rx_multicast",
		"tx_bytes", "tx_packets", "tx_errs", "tx_drop",
		"tx_fifo", "tx_colls", "tx_carrier", "tx_compressed",
	}
	var rows []result.SnapshotRow
	lines := strings.Split(text, "\n")
	if len(lines) < 3 {
		return nil
	}
	for _, line := range lines[2:] { // first two lines are header
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}
		iface := strings.TrimSpace(line[:colonIdx])
		if iface == "lo" {
			continue
		}
		fields := strings.Fields(line[colonIdx+1:])
		row := result.SnapshotRow{"iface": iface}
		for i, col := range colNames {
			if i >= len(fields) {
				break
			}
			if v, err := strconv.ParseInt(fields[i], 10, 64); err == nil {
				row[col] = v
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func parseSchedstat(text string) []result.SnapshotRow {
	var rows []result.SnapshotRow
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		// Only cpu* lines; skip version, timestamp, domain lines
		if !strings.HasPrefix(line, "cpu") || strings.HasPrefix(line, "cpuid") {
			continue
		}
		fields := strings.Fields(line)
		// Version 15: cpu<N> [6 legacy zeros] run_time_ns wait_time_ns timeslices = 10 fields
		if len(fields) < 10 {
			continue
		}
		row := result.SnapshotRow{"cpu_id": fields[0]}
		if v, err := strconv.ParseInt(fields[7], 10, 64); err == nil {
			row["run_time_ns"] = v
		}
		if v, err := strconv.ParseInt(fields[8], 10, 64); err == nil {
			row["wait_time_ns"] = v
		}
		if v, err := strconv.ParseInt(fields[9], 10, 64); err == nil {
			row["timeslices"] = v
		}
		rows = append(rows, row)
	}
	return rows
}

func parsePsiLine(line string) map[string]float64 {
	vals := make(map[string]float64)
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return vals
	}
	lineType := fields[0] // "some" or "full"
	for _, kv := range fields[1:] {
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := lineType + "_" + parts[0] // e.g. "some_avg10"
		if v, err := strconv.ParseFloat(parts[1], 64); err == nil {
			vals[key] = v
		}
	}
	return vals
}

func parsePsi(cpuText, memText, ioText string) result.SnapshotRow {
	row := result.SnapshotRow{}
	for _, line := range strings.Split(cpuText, "\n") {
		for k, v := range parsePsiLine(strings.TrimSpace(line)) {
			row["cpu_"+k] = v
		}
	}
	for _, line := range strings.Split(memText, "\n") {
		for k, v := range parsePsiLine(strings.TrimSpace(line)) {
			row["memory_"+k] = v
		}
	}
	for _, line := range strings.Split(ioText, "\n") {
		for k, v := range parsePsiLine(strings.TrimSpace(line)) {
			row["io_"+k] = v
		}
	}
	if len(row) == 0 {
		return nil
	}
	return row
}

func parseFileNr(text string) result.SnapshotRow {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) < 1 {
		return nil
	}
	row := result.SnapshotRow{}
	if v, err := strconv.ParseInt(fields[0], 10, 64); err == nil {
		row["allocated"] = v
	}
	if len(fields) >= 3 {
		if v, err := strconv.ParseInt(fields[2], 10, 64); err == nil {
			row["max"] = v
		}
	}
	return row
}

// --- Per-PID parsers ---

// parsePidCmdline normalises /proc/<pid>/cmdline (null bytes already replaced by spaces).
// Returns the full command line string, or "" if empty.
func parsePidCmdline(text string) string {
	// Replace any lingering null bytes (in case tr didn't run) and trim.
	s := strings.ReplaceAll(strings.TrimSpace(text), "\x00", " ")
	return strings.Join(strings.Fields(s), " ")
}

func parsePidStat(line string, pid int) result.SnapshotRow {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	row := result.SnapshotRow{"pid": int64(pid)}

	// Extract comm: between first ( and last )
	commStart := strings.Index(line, "(")
	commEnd := strings.LastIndex(line, ")")
	if commStart < 0 || commEnd <= commStart {
		return row
	}
	row["comm"] = line[commStart+1 : commEnd]

	// Fields after ")": state ppid pgrp session ... (restFields[0] = state)
	rest := strings.TrimSpace(line[commEnd+1:])
	restFields := strings.Fields(rest)
	if len(restFields) >= 1 {
		row["state"] = restFields[0]
	}

	// restFields[i] = stat field (i+3), where field numbering starts at 1
	// minflt=field10 → restFields[7], majflt=field12 → restFields[9]
	// utime=field14 → restFields[11], stime=field15 → restFields[12]
	// num_threads=field20 → restFields[17]
	// vsize=field23 → restFields[20], rss=field24 → restFields[21]
	fieldMap := map[int]string{
		7: "minflt", 9: "majflt",
		11: "utime", 12: "stime",
		17: "num_threads",
		20: "vsize", 21: "rss",
	}
	for idx, col := range fieldMap {
		if idx < len(restFields) {
			if v, err := strconv.ParseInt(restFields[idx], 10, 64); err == nil {
				row[col] = v
			}
		}
	}
	return row
}

func parsePidStatm(text string, pid int) result.SnapshotRow {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) < 2 {
		return nil
	}
	row := result.SnapshotRow{"pid": int64(pid)}
	colNames := []string{"size", "resident", "shared", "text", "lib", "data", "dt"}
	for i, col := range colNames {
		if i >= len(fields) {
			break
		}
		if v, err := strconv.ParseInt(fields[i], 10, 64); err == nil {
			row[col] = v
		}
	}
	return row
}

func parsePidIO(text string, pid int) result.SnapshotRow {
	row := result.SnapshotRow{"pid": int64(pid)}
	for _, line := range strings.Split(text, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		if v, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); err == nil {
			row[key] = v
		}
	}
	if len(row) <= 1 { // only pid
		return nil
	}
	return row
}

func parsePidSchedstat(text string, pid int) result.SnapshotRow {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) < 3 {
		return nil
	}
	row := result.SnapshotRow{"pid": int64(pid)}
	if v, err := strconv.ParseInt(fields[0], 10, 64); err == nil {
		row["run_time_ns"] = v
	}
	if v, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
		row["wait_time_ns"] = v
	}
	if v, err := strconv.ParseInt(fields[2], 10, 64); err == nil {
		row["timeslices"] = v
	}
	return row
}

func parsePidWchan(text string, pid int) result.SnapshotRow {
	wchan := strings.TrimSpace(text)
	if wchan == "" {
		return nil
	}
	return result.SnapshotRow{"pid": int64(pid), "wchan": wchan}
}

func parsePidFdCount(text string, pid int) result.SnapshotRow {
	v, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
	if err != nil {
		return nil
	}
	return result.SnapshotRow{"pid": int64(pid), "fd_count": v}
}

func parsePidStatus(text string, pid int) result.SnapshotRow {
	colMap := map[string]string{
		"Name": "name", "State": "state", "FDSize": "fd_size", "Threads": "threads",
		"VmPeak": "vm_peak_kb", "VmSize": "vm_size_kb", "VmRSS": "vm_rss_kb",
		"RssAnon": "rss_anon_kb", "RssFile": "rss_file_kb", "RssShmem": "rss_shmem_kb",
		"VmSwap":                     "vm_swap_kb",
		"voluntary_ctxt_switches":    "vol_ctxt_sw",
		"nonvoluntary_ctxt_switches": "nvol_ctxt_sw",
	}
	row := result.SnapshotRow{"pid": int64(pid)}
	for _, line := range strings.Split(text, "\n") {
		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colonIdx])
		col, ok := colMap[key]
		if !ok {
			continue
		}
		valStr := strings.TrimSpace(line[colonIdx+1:])
		if key == "Name" {
			row[col] = valStr
		} else if key == "State" {
			// "S (sleeping)" → just the single letter
			if len(valStr) > 0 {
				row[col] = string(valStr[0])
			}
		} else {
			// Strip "kB" suffix and parse as integer
			valStr = strings.TrimSpace(strings.TrimSuffix(valStr, "kB"))
			if v, err := strconv.ParseInt(strings.TrimSpace(valStr), 10, 64); err == nil {
				row[col] = v
			}
		}
	}
	if len(row) <= 1 { // only pid
		return nil
	}
	return row
}
