package result

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestResultJSONNoStepResults(t *testing.T) {
	r := &Result{
		Version:       1,
		DesignID:      1,
		RunnerVersion: "0.1.0",
		Run: RunSummary{
			Status:    "completed",
			StartedAt: "2024-01-01T00:00:00Z",
		},
		Snapshots: map[string][]SnapshotRow{},
	}

	data, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("unexpected marshal error: %v", err)
	}

	jsonStr := string(data)
	if strings.Contains(jsonStr, "step_results") {
		t.Errorf("result JSON must not contain 'step_results', got: %s", jsonStr)
	}
}

func TestResultJSONHasSnapshots(t *testing.T) {
	r := &Result{
		Version:       1,
		DesignID:      2,
		RunnerVersion: "0.1.0",
		Run: RunSummary{
			Status:    "completed",
			StartedAt: "2024-01-01T00:00:00Z",
			TPS:       279.5,
		},
		Snapshots: map[string][]SnapshotRow{
			"snap_pg_stat_database": {
				{
					"_collected_at": "2024-01-01T00:00:05Z",
					"_phase":        "pre",
					"datname":       "benchmark",
					"xact_commit":   float64(12345),
				},
			},
		},
	}

	data, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("unexpected marshal error: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unexpected unmarshal error: %v", err)
	}

	snapshots, ok := decoded["snapshots"].(map[string]any)
	if !ok {
		t.Fatal("expected 'snapshots' key in result JSON")
	}

	tableRows, ok := snapshots["snap_pg_stat_database"].([]any)
	if !ok {
		t.Fatal("expected 'snap_pg_stat_database' key in snapshots")
	}

	if len(tableRows) != 1 {
		t.Fatalf("expected 1 snapshot row, got %d", len(tableRows))
	}

	row, ok := tableRows[0].(map[string]any)
	if !ok {
		t.Fatal("expected snapshot row to be a map")
	}

	if row["_phase"] != "pre" {
		t.Errorf("expected _phase=pre, got %v", row["_phase"])
	}
	if row["datname"] != "benchmark" {
		t.Errorf("expected datname=benchmark, got %v", row["datname"])
	}

	// Confirm no step_results
	jsonStr := string(data)
	if strings.Contains(jsonStr, "step_results") {
		t.Errorf("result JSON must not contain 'step_results'")
	}
}

func TestResultJSONHasCheckpointerSnapshots(t *testing.T) {
	r := &Result{
		Version:       1,
		DesignID:      3,
		RunnerVersion: "0.1.0",
		Run: RunSummary{
			Status:    "completed",
			StartedAt: "2024-01-01T00:00:00Z",
		},
		Snapshots: map[string][]SnapshotRow{
			"snap_pg_stat_checkpointer": {
				{
					"_collected_at":   "2024-01-01T00:00:05Z",
					"_phase":          "bench",
					"num_timed":       float64(2),
					"num_requested":   float64(1),
					"buffers_written": float64(512),
				},
			},
		},
	}

	data, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("unexpected marshal error: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unexpected unmarshal error: %v", err)
	}

	snapshots := decoded["snapshots"].(map[string]any)
	rows := snapshots["snap_pg_stat_checkpointer"].([]any)
	row := rows[0].(map[string]any)

	if row["_phase"] != "bench" {
		t.Errorf("expected _phase=bench, got %v", row["_phase"])
	}
	if row["buffers_written"] != float64(512) {
		t.Errorf("expected buffers_written=512, got %v", row["buffers_written"])
	}
}

func TestResultJSONOmitsEmptyFields(t *testing.T) {
	r := &Result{
		Version:       1,
		DesignID:      1,
		RunnerVersion: "0.1.0",
		Run: RunSummary{
			Status:    "failed",
			StartedAt: "2024-01-01T00:00:00Z",
		},
		Snapshots: map[string][]SnapshotRow{},
	}

	data, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("unexpected marshal error: %v", err)
	}

	jsonStr := string(data)
	// Fields with omitempty should not appear when zero
	if strings.Contains(jsonStr, `"bench_started_at"`) {
		t.Error("bench_started_at should be omitted when empty")
	}
	if strings.Contains(jsonStr, `"tps":0`) {
		t.Error("tps should be omitted when zero")
	}
}
