package runner

import (
	"testing"

	"github.com/khanh1998/mybench/cli/internal/plan"
)

func stringValue(ptr *string) string {
	if ptr == nil {
		return ""
	}
	return *ptr
}

func intValue(ptr *int) int {
	if ptr == nil {
		return 0
	}
	return *ptr
}

func floatValue(ptr *float64) float64 {
	if ptr == nil {
		return 0
	}
	return *ptr
}

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
		"maximum number of tries: 1",
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
	if stringValue(res.TransactionType) != "<builtin: TPC-B (sort of)>" {
		t.Errorf("expected TransactionType to be parsed, got %q", stringValue(res.TransactionType))
	}
	if intValue(res.ScalingFactor) != 1 {
		t.Errorf("expected ScalingFactor=1, got %d", intValue(res.ScalingFactor))
	}
	if stringValue(res.QueryMode) != "simple" {
		t.Errorf("expected QueryMode=simple, got %q", stringValue(res.QueryMode))
	}
	if intValue(res.NumberOfClients) != 30 {
		t.Errorf("expected NumberOfClients=30, got %d", intValue(res.NumberOfClients))
	}
	if intValue(res.NumberOfThreads) != 2 {
		t.Errorf("expected NumberOfThreads=2, got %d", intValue(res.NumberOfThreads))
	}
	if intValue(res.MaximumTries) != 1 {
		t.Errorf("expected MaximumTries=1, got %d", intValue(res.MaximumTries))
	}
	if intValue(res.DurationSecs) != 120 {
		t.Errorf("expected DurationSecs=120, got %d", intValue(res.DurationSecs))
	}
	if floatValue(res.InitialConnectionTimeMs) != 254.567 {
		t.Errorf("expected InitialConnectionTimeMs=254.567, got %f", floatValue(res.InitialConnectionTimeMs))
	}
}

func TestParsePgbenchOutputNoMatch(t *testing.T) {
	line := "this line has no pgbench metrics"
	var res pgbenchResult
	parsePgbenchOutput(line, &res)
	if res.TPS != 0 || res.LatencyAvgMs != 0 || res.LatencyStddevMs != 0 || res.Transactions != 0 || res.FailedTransactions != 0 {
		t.Error("expected all zero metrics for non-matching line")
	}
	if res.TransactionType != nil || res.ScalingFactor != nil || res.QueryMode != nil || res.NumberOfClients != nil || res.NumberOfThreads != nil || res.MaximumTries != nil || res.DurationSecs != nil || res.InitialConnectionTimeMs != nil {
		t.Error("expected optional metadata pointers to remain nil for non-matching line")
	}
}

func TestParsePgbenchFinalOutputKeepsOverallSummaryAndScriptDetails(t *testing.T) {
	output := `pgbench (16.11, server 18.3)
transaction type: multiple scripts
scaling factor: 1
query mode: prepared
number of clients: 30
number of threads: 2
maximum number of tries: 1
duration: 60 s
number of transactions actually processed: 19646
number of failed transactions: 0 (0.000%)
latency average = 898.249 ms
latency stddev = 7394.088 ms
initial connection time = 465.506 ms
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
	if stringValue(summary.TransactionType) != "multiple scripts" {
		t.Fatalf("expected TransactionType=multiple scripts, got %q", stringValue(summary.TransactionType))
	}
	if intValue(summary.ScalingFactor) != 1 {
		t.Fatalf("expected ScalingFactor=1, got %d", intValue(summary.ScalingFactor))
	}
	if stringValue(summary.QueryMode) != "prepared" {
		t.Fatalf("expected QueryMode=prepared, got %q", stringValue(summary.QueryMode))
	}
	if intValue(summary.NumberOfClients) != 30 || intValue(summary.NumberOfThreads) != 2 {
		t.Fatalf("expected client/thread metadata to be parsed, got clients=%d threads=%d", intValue(summary.NumberOfClients), intValue(summary.NumberOfThreads))
	}
	if intValue(summary.MaximumTries) != 1 {
		t.Fatalf("expected MaximumTries=1, got %d", intValue(summary.MaximumTries))
	}
	if intValue(summary.DurationSecs) != 60 {
		t.Fatalf("expected DurationSecs=60, got %d", intValue(summary.DurationSecs))
	}
	if floatValue(summary.InitialConnectionTimeMs) != 465.506 {
		t.Fatalf("expected InitialConnectionTimeMs=465.506, got %f", floatValue(summary.InitialConnectionTimeMs))
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
