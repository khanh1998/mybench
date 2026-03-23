package runner

import (
	"testing"
)

func TestParseTPS(t *testing.T) {
	line := "tps = 279.500000 (without initial connection time)"
	var res pgbenchResult
	parsePgbenchOutput(line, &res)
	if res.TPS != 279.5 {
		t.Errorf("expected TPS=279.5, got %f", res.TPS)
	}
}

func TestParseLatencyAvg(t *testing.T) {
	line := "latency average = 107.123 ms"
	var res pgbenchResult
	parsePgbenchOutput(line, &res)
	if res.LatencyAvgMs != 107.123 {
		t.Errorf("expected LatencyAvgMs=107.123, got %f", res.LatencyAvgMs)
	}
}

func TestParseLatencyStddev(t *testing.T) {
	line := "latency stddev = 136.400000 ms"
	var res pgbenchResult
	parsePgbenchOutput(line, &res)
	if res.LatencyStddevMs != 136.4 {
		t.Errorf("expected LatencyStddevMs=136.4, got %f", res.LatencyStddevMs)
	}
}

func TestParseTransactions(t *testing.T) {
	line := "number of transactions actually processed: 33498"
	var res pgbenchResult
	parsePgbenchOutput(line, &res)
	if res.Transactions != 33498 {
		t.Errorf("expected Transactions=33498, got %d", res.Transactions)
	}
}

func TestParsePgbenchOutputSample(t *testing.T) {
	// Realistic pgbench output sample
	lines := []string{
		"pgbench (PostgreSQL) 15.3",
		"starting vacuum...end.",
		"transaction type: <builtin: TPC-B (sort of)>",
		"scaling factor: 1",
		"query mode: simple",
		"number of clients: 30",
		"number of threads: 2",
		"duration: 120 s",
		"number of transactions actually processed: 33498",
		"number of failed transactions: 0 (0.000%)",
		"latency average = 107.456 ms",
		"latency stddev = 136.400000 ms",
		"initial connection time = 254.567 ms",
		"tps = 279.500000 (without initial connection time)",
	}

	var res pgbenchResult
	for _, line := range lines {
		parsePgbenchOutput(line, &res)
	}

	if res.TPS != 279.5 {
		t.Errorf("expected TPS=279.5, got %f", res.TPS)
	}
	if res.LatencyAvgMs != 107.456 {
		t.Errorf("expected LatencyAvgMs=107.456, got %f", res.LatencyAvgMs)
	}
	if res.LatencyStddevMs != 136.4 {
		t.Errorf("expected LatencyStddevMs=136.4, got %f", res.LatencyStddevMs)
	}
	if res.Transactions != 33498 {
		t.Errorf("expected Transactions=33498, got %d", res.Transactions)
	}
}

func TestParsePgbenchOutputNoMatch(t *testing.T) {
	line := "this line has no pgbench metrics"
	var res pgbenchResult
	parsePgbenchOutput(line, &res)
	if res.TPS != 0 || res.LatencyAvgMs != 0 || res.LatencyStddevMs != 0 || res.Transactions != 0 {
		t.Error("expected all zero metrics for non-matching line")
	}
}
