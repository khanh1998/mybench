package runner

import (
	"testing"

	"github.com/khanh1998/mybench/cli/internal/plan"
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

func TestParseFailedTransactions(t *testing.T) {
	line := "number of failed transactions: 0 (0.000%)"
	var res pgbenchResult
	parsePgbenchOutput(line, &res)
	if res.FailedTransactions != 0 {
		t.Errorf("expected FailedTransactions=0, got %d", res.FailedTransactions)
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
	if res.TPS != 0 || res.LatencyAvgMs != 0 || res.LatencyStddevMs != 0 || res.Transactions != 0 || res.FailedTransactions != 0 {
		t.Error("expected all zero metrics for non-matching line")
	}
}

func TestParsePgbenchFinalOutputKeepsOverallSummaryAndScriptDetails(t *testing.T) {
	output := `pgbench (16.11, server 18.3)
transaction type: multiple scripts
number of transactions actually processed: 19646
number of failed transactions: 0 (0.000%)
latency average = 898.249 ms
latency stddev = 7394.088 ms
tps = 64.854015 (without initial connection time)
SQL script 1: /tmp/script-1.pgbench
 - weight: 10 (targets 10.0% of total)
 - 1993 transactions (10.1% of total, tps = 6.579154)
 - number of failed transactions: 0 (0.000%)
 - latency average = 85.066 ms
 - latency stddev = 278.990 ms
SQL script 2: /tmp/script-2.pgbench
 - weight: 25 (targets 25.0% of total)
 - 4916 transactions (25.0% of total, tps = 16.228359)
 - number of failed transactions: 0 (0.000%)
 - latency average = 325.612 ms
 - latency stddev = 2451.746 ms`

	summary, scripts := parsePgbenchFinalOutput(output, []plan.PgbenchScript{
		{Name: "main", Weight: 10, Script: "SELECT 1;"},
		{Name: "refund", Weight: 25, Script: "SELECT 2;"},
	})

	if summary == nil {
		t.Fatal("expected summary to be parsed")
	}
	if summary.TPS != 64.854015 {
		t.Fatalf("expected overall TPS=64.854015, got %f", summary.TPS)
	}
	if summary.LatencyAvgMs != 898.249 {
		t.Fatalf("expected overall LatencyAvgMs=898.249, got %f", summary.LatencyAvgMs)
	}
	if len(scripts) != 2 {
		t.Fatalf("expected 2 script results, got %d", len(scripts))
	}
	if scripts[0].Name != "main" || scripts[0].Weight != 10 || scripts[0].Script != "SELECT 1;" {
		t.Fatalf("expected first script snapshot to come from the plan, got %+v", scripts[0])
	}
	if scripts[1].LatencyAvgMs != 325.612 {
		t.Fatalf("expected second script LatencyAvgMs=325.612, got %f", scripts[1].LatencyAvgMs)
	}
	if scripts[0].Transactions != 1993 {
		t.Fatalf("expected first script Transactions=1993, got %d", scripts[0].Transactions)
	}
	if scripts[1].TPS != 16.228359 {
		t.Fatalf("expected second script TPS=16.228359, got %f", scripts[1].TPS)
	}
	if summary.LatencyAvgMs == scripts[1].LatencyAvgMs {
		t.Fatal("overall summary should not be overwritten by the last script block")
	}
}
