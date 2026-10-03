package runner

import (
	"context"
	"fmt"
	"math"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/khanh1998/mybench/cli/internal/result"
)

const (
	netProbeSelectWarmup  = 5
	netProbeSelectSamples = 100
	netProbePingCount     = 20
	netProbePingInterval  = 0.2 // seconds; the minimum allowed for non-root users
	netProbeTimeout       = 5 * time.Second
)

// ProbeNetwork measures client→database latency from the runner host. It runs a
// SQL round-trip probe (SELECT 1) and an ICMP ping concurrently, bounded by
// netProbeTimeout. Failures are recorded per probe and never abort the run.
func ProbeNetwork(ctx context.Context, pool *pgxpool.Pool, host string) *result.NetLatency {
	ctx, cancel := context.WithTimeout(ctx, netProbeTimeout)
	defer cancel()

	out := &result.NetLatency{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		out.Select1, out.Select1Error = probeSelect1(ctx, pool)
	}()
	go func() {
		defer wg.Done()
		out.Ping, out.PingError = probePing(ctx, host)
	}()
	wg.Wait()
	return out
}

// probeSelect1 times single-round-trip SELECT 1 calls on one warm connection.
// It uses the simple query protocol so each sample is exactly one network
// round trip (no Parse/Describe on the first call).
func probeSelect1(ctx context.Context, pool *pgxpool.Pool) (*result.LatencyStats, string) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, err.Error()
	}
	defer conn.Release()
	pgc := conn.Conn().PgConn()

	for i := 0; i < netProbeSelectWarmup; i++ {
		if _, err := pgc.Exec(ctx, "SELECT 1").ReadAll(); err != nil {
			return nil, err.Error()
		}
	}

	samples := make([]float64, 0, netProbeSelectSamples)
	for i := 0; i < netProbeSelectSamples; i++ {
		start := time.Now()
		if _, err := pgc.Exec(ctx, "SELECT 1").ReadAll(); err != nil {
			if len(samples) == 0 {
				return nil, err.Error()
			}
			break // timed out part-way: report what we have
		}
		samples = append(samples, float64(time.Since(start).Microseconds())/1000.0)
	}
	return computeLatencyStats(samples), ""
}

func computeLatencyStats(samples []float64) *result.LatencyStats {
	n := len(samples)
	if n == 0 {
		return nil
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	var sum float64
	for _, v := range sorted {
		sum += v
	}
	avg := sum / float64(n)
	var sq float64
	for _, v := range sorted {
		sq += (v - avg) * (v - avg)
	}
	return &result.LatencyStats{
		Samples:  n,
		MinMs:    sorted[0],
		AvgMs:    avg,
		P50Ms:    percentile(sorted, 0.50),
		P95Ms:    percentile(sorted, 0.95),
		MaxMs:    sorted[n-1],
		StddevMs: math.Sqrt(sq / float64(n)),
	}
}

// percentile uses linear interpolation on an ascending-sorted slice.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	pos := p * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-float64(lo))
}

var (
	pingPacketsRe = regexp.MustCompile(`(\d+) packets transmitted, (\d+)(?: packets)? received`)
	pingRttRe     = regexp.MustCompile(`= ([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+) ms`)
)

func probePing(ctx context.Context, host string) (*result.PingStats, string) {
	bin, err := exec.LookPath("ping")
	if err != nil {
		return nil, "ping not installed"
	}
	args := []string{"-n", "-c", strconv.Itoa(netProbePingCount), "-i", strconv.FormatFloat(netProbePingInterval, 'f', 1, 64)}
	if runtime.GOOS == "linux" {
		// -w makes ping stop at the deadline and still print its summary
		// (a context kill would lose it); -W caps the wait for each reply.
		args = append(args, "-w", strconv.Itoa(int(netProbeTimeout.Seconds())-1), "-W", "1")
	}
	args = append(args, host)

	// Ignore the error: ping exits non-zero on 100% loss but still prints a summary.
	outBytes, runErr := exec.CommandContext(ctx, bin, args...).CombinedOutput()
	stats, perr := parsePingOutput(string(outBytes))
	if perr != "" && runErr != nil {
		return nil, fmt.Sprintf("%s (%v)", perr, runErr)
	}
	return stats, perr
}

// parsePingOutput parses Linux (iputils) and macOS/BSD ping summaries.
func parsePingOutput(out string) (*result.PingStats, string) {
	pk := pingPacketsRe.FindStringSubmatch(out)
	if pk == nil {
		return nil, "could not parse ping output"
	}
	sent, _ := strconv.Atoi(pk[1])
	recv, _ := strconv.Atoi(pk[2])
	stats := &result.PingStats{Sent: sent, Received: recv}
	if sent > 0 {
		stats.LossPct = float64(sent-recv) / float64(sent) * 100
	}
	rtt := pingRttRe.FindStringSubmatch(out)
	if rtt == nil {
		if recv == 0 {
			return stats, "no replies (ICMP likely blocked)"
		}
		return nil, "could not parse ping rtt line"
	}
	stats.MinMs, _ = strconv.ParseFloat(rtt[1], 64)
	stats.AvgMs, _ = strconv.ParseFloat(rtt[2], 64)
	stats.MaxMs, _ = strconv.ParseFloat(rtt[3], 64)
	stats.MdevMs, _ = strconv.ParseFloat(rtt[4], 64)
	return stats, ""
}

func summarizeNetLatency(n *result.NetLatency) string {
	s1, pg := "select1=n/a", "ping=n/a"
	if n.Select1 != nil {
		s1 = fmt.Sprintf("select1 p50=%.3fms p95=%.3fms", n.Select1.P50Ms, n.Select1.P95Ms)
	} else if n.Select1Error != "" {
		s1 = "select1 failed: " + n.Select1Error
	}
	if n.Ping != nil && n.PingError == "" {
		pg = fmt.Sprintf("ping avg=%.3fms loss=%.0f%%", n.Ping.AvgMs, n.Ping.LossPct)
	} else if n.PingError != "" {
		pg = "ping unavailable: " + n.PingError
	}
	return s1 + ", " + pg
}
