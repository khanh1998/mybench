package runner

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
	"golang.org/x/crypto/ssh"
)

// OSMetricsCollector manages SSH-based OS metrics collection during a benchmark run.
type OSMetricsCollector struct {
	mu         sync.Mutex
	dataPoints []result.CloudWatchDataPoint
	client     *ssh.Client
	stopCh     chan struct{}
	doneCh     chan struct{}
}

// NewOSMetricsCollector creates and starts an SSH-based metrics collector.
// Returns nil (with a warning printed) if SSH config is absent or connection fails.
func NewOSMetricsCollector(srv plan.ServerConfig) *OSMetricsCollector {
	if !srv.SSHEnabled || srv.SSHUser == "" || srv.SSHPrivateKey == "" {
		return nil
	}

	signer, err := ssh.ParsePrivateKey([]byte(srv.SSHPrivateKey))
	if err != nil {
		fmt.Printf("warning: os_metrics: parse SSH key: %v\n", err)
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
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec — internal tooling, no MITM risk
		Timeout:         15 * time.Second,
	}

	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		fmt.Printf("warning: os_metrics: SSH connect to %s: %v\n", addr, err)
		return nil
	}

	c := &OSMetricsCollector{
		client: client,
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
	go c.collect()
	return c
}

// Stop signals the collector to shut down and waits for it to finish.
// Returns all collected data points.
func (c *OSMetricsCollector) Stop() []result.CloudWatchDataPoint {
	close(c.stopCh)
	<-c.doneCh
	c.client.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dataPoints
}

// collect runs vmstat and iostat in parallel, parsing their output into datapoints.
func (c *OSMetricsCollector) collect() {
	defer close(c.doneCh)

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		c.runVmstat()
	}()
	go func() {
		defer wg.Done()
		c.runIostat()
	}()

	wg.Wait()
}

func (c *OSMetricsCollector) runVmstat() {
	sess, err := c.client.NewSession()
	if err != nil {
		fmt.Printf("warning: os_metrics: vmstat session: %v\n", err)
		return
	}
	defer sess.Close()

	pr, pw := io.Pipe()
	sess.Stdout = pw

	if err := sess.Start("vmstat 1 2>/dev/null"); err != nil {
		fmt.Printf("warning: os_metrics: vmstat start: %v\n", err)
		return
	}

	// vmstat header lines: line 1 = procs/memory/swap/.., line 2 = column names, lines 3+ = data
	// Format (procps): r  b   swpd   free   buff  cache  si  so  bi  bo  in  cs us sy id wa st
	scanner := bufio.NewScanner(pr)
	lineNum := 0
	var headers []string

	done := make(chan struct{})
	go func() {
		defer close(done)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			lineNum++
			if lineNum <= 1 {
				continue // skip first header line (section labels)
			}
			if lineNum == 2 {
				headers = strings.Fields(line)
				continue
			}
			if len(headers) == 0 {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < len(headers) {
				continue
			}
			ts := time.Now().UTC().Format(time.RFC3339)
			// Map column names to metric names
			colMap := map[string]string{
				"us": "os_cpu_usr",
				"sy": "os_cpu_sys",
				"wa": "os_cpu_iowait",
				"st": "os_cpu_steal",
				"id": "os_cpu_idle",
				"free": "os_mem_free_kb",
				"swpd": "os_mem_swapped_kb",
			}
			idxMap := make(map[string]int, len(headers))
			for i, h := range headers {
				idxMap[h] = i
			}
			for col, metricName := range colMap {
				idx, ok := idxMap[col]
				if !ok || idx >= len(fields) {
					continue
				}
				val, err := strconv.ParseFloat(fields[idx], 64)
				if err != nil {
					continue
				}
				unit := "Percent"
				if strings.HasPrefix(metricName, "os_mem") {
					unit = "Kilobytes"
				}
				c.mu.Lock()
				c.dataPoints = append(c.dataPoints, result.CloudWatchDataPoint{
					MetricName: metricName,
					Timestamp:  ts,
					Value:      val,
					Unit:       unit,
				})
				c.mu.Unlock()
			}
		}
	}()

	select {
	case <-c.stopCh:
		sess.Signal(ssh.SIGTERM) //nolint:errcheck
		pw.Close()
	case <-done:
		pw.Close()
	}
	<-done
}

func (c *OSMetricsCollector) runIostat() {
	sess, err := c.client.NewSession()
	if err != nil {
		fmt.Printf("warning: os_metrics: iostat session: %v\n", err)
		return
	}
	defer sess.Close()

	pr, pw := io.Pipe()
	sess.Stdout = pw

	if err := sess.Start("iostat -x 1 2>/dev/null"); err != nil {
		fmt.Printf("warning: os_metrics: iostat start: %v\n", err)
		return
	}

	// iostat -x output: blank line, "Device" header line, then data rows per device
	// Columns include: Device, r/s, w/s, rkB/s, wkB/s, %util, await, etc.
	scanner := bufio.NewScanner(pr)
	var headers []string
	inDeviceSection := false
	var lastTs string

	done := make(chan struct{})
	go func() {
		defer close(done)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				inDeviceSection = false
				lastTs = time.Now().UTC().Format(time.RFC3339)
				continue
			}
			if strings.HasPrefix(line, "Device") {
				headers = strings.Fields(line)
				inDeviceSection = true
				continue
			}
			if !inDeviceSection || len(headers) == 0 {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			ts := lastTs
			if ts == "" {
				ts = time.Now().UTC().Format(time.RFC3339)
			}
			device := fields[0]
			// Only collect primary block devices
			if !isPrimaryDevice(device) {
				continue
			}
			idxMap := make(map[string]int, len(headers))
			for i, h := range headers {
				idxMap[h] = i
			}
			// iostat column name variations across distros
			colAliases := []struct {
				names  []string
				metric string
				unit   string
			}{
				{[]string{"rkB/s", "kB_read/s"}, "os_disk_read_kbs", "Kilobytes/Second"},
				{[]string{"wkB/s", "kB_wrtn/s"}, "os_disk_write_kbs", "Kilobytes/Second"},
				{[]string{"%util"}, "os_disk_util_pct", "Percent"},
			}
			for _, ca := range colAliases {
				for _, colName := range ca.names {
					idx, ok := idxMap[colName]
					if !ok || idx >= len(fields) {
						continue
					}
					val, err := strconv.ParseFloat(fields[idx], 64)
					if err != nil {
						continue
					}
					c.mu.Lock()
					c.dataPoints = append(c.dataPoints, result.CloudWatchDataPoint{
						MetricName: ca.metric + "_" + device,
						Timestamp:  ts,
						Value:      val,
						Unit:       ca.unit,
					})
					c.mu.Unlock()
					break
				}
			}
		}
	}()

	select {
	case <-c.stopCh:
		sess.Signal(ssh.SIGTERM) //nolint:errcheck
		pw.Close()
	case <-done:
		pw.Close()
	}
	<-done
}

// isPrimaryDevice returns true for common primary block devices (sda, xvda, nvme0n1, vda).
func isPrimaryDevice(name string) bool {
	primaryPrefixes := []string{"sda", "xvda", "nvme0n1", "vda", "sdb", "xvdb"}
	for _, prefix := range primaryPrefixes {
		if name == prefix {
			return true
		}
	}
	return false
}
