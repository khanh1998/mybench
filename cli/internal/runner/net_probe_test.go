package runner

import (
	"math"
	"testing"
)

func TestParsePingOutputLinux(t *testing.T) {
	out := `PING 10.0.0.5 (10.0.0.5) 56(84) bytes of data.

--- 10.0.0.5 ping statistics ---
20 packets transmitted, 19 received, 5% packet loss, time 3801ms
rtt min/avg/max/mdev = 0.351/0.402/0.512/0.045 ms
`
	s, errMsg := parsePingOutput(out)
	if errMsg != "" || s == nil {
		t.Fatalf("unexpected error %q", errMsg)
	}
	if s.Sent != 20 || s.Received != 19 || s.LossPct != 5 || s.MinMs != 0.351 || s.AvgMs != 0.402 || s.MaxMs != 0.512 || s.MdevMs != 0.045 {
		t.Fatalf("bad parse: %+v", s)
	}
}

func TestParsePingOutputMac(t *testing.T) {
	out := `--- host ping statistics ---
10 packets transmitted, 10 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 12.1/13.2/15.0/0.9 ms
`
	s, errMsg := parsePingOutput(out)
	if errMsg != "" || s.AvgMs != 13.2 || s.Received != 10 {
		t.Fatalf("bad parse: %+v %q", s, errMsg)
	}
}

func TestParsePingOutputAllLost(t *testing.T) {
	out := "20 packets transmitted, 0 received, 100% packet loss, time 4000ms\n"
	s, errMsg := parsePingOutput(out)
	if s == nil || errMsg == "" || s.LossPct != 100 {
		t.Fatalf("expected blocked-ICMP result, got %+v %q", s, errMsg)
	}
}

func TestParsePingOutputGarbage(t *testing.T) {
	if s, errMsg := parsePingOutput("ping: unknown host"); s != nil || errMsg == "" {
		t.Fatalf("expected parse failure, got %+v %q", s, errMsg)
	}
}

func TestComputeLatencyStats(t *testing.T) {
	s := computeLatencyStats([]float64{5, 1, 3, 2, 4})
	if s.Samples != 5 || s.MinMs != 1 || s.MaxMs != 5 || s.AvgMs != 3 || s.P50Ms != 3 {
		t.Fatalf("bad stats: %+v", s)
	}
	if math.Abs(s.P95Ms-4.8) > 1e-9 {
		t.Fatalf("p95 = %v, want 4.8", s.P95Ms)
	}
	if computeLatencyStats(nil) != nil {
		t.Fatal("empty input should return nil")
	}
}
