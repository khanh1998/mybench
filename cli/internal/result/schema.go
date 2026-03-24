package result

// Result is the top-level structure written to result.json.
type Result struct {
	Version       int                        `json:"version"`
	DesignID      int                        `json:"design_id"`
	RunnerVersion string                     `json:"runner_version"`
	Run           RunSummary                 `json:"run"`
	Steps         []StepResult               `json:"steps"`
	Snapshots     map[string][]SnapshotRow   `json:"snapshots"`
}

// StepResult records execution metadata for a single step.
type StepResult struct {
	StepID     int    `json:"step_id"`
	Position   int    `json:"position"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Status     string `json:"status"` // "completed" or "failed"
	Command    string `json:"command,omitempty"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at"`
}

// RunSummary contains the benchmark run metadata and pgbench parsed output.
type RunSummary struct {
	Status                  string  `json:"status"` // "completed", "failed", "stopped"
	StartedAt               string  `json:"started_at"`
	FinishedAt              string  `json:"finished_at,omitempty"`
	BenchStartedAt          string  `json:"bench_started_at,omitempty"`
	PostStartedAt           string  `json:"post_started_at,omitempty"`
	SnapshotIntervalSeconds int     `json:"snapshot_interval_seconds"`
	PreCollectSecs          int     `json:"pre_collect_secs"`
	PostCollectSecs         int     `json:"post_collect_secs"`
	TPS                     float64 `json:"tps,omitempty"`
	LatencyAvgMs            float64 `json:"latency_avg_ms,omitempty"`
	LatencyStddevMs         float64 `json:"latency_stddev_ms,omitempty"`
	Transactions            int64   `json:"transactions,omitempty"`
}

// SnapshotRow is a single row from a pg_stat_* view, keyed by column name.
// The special keys _collected_at and _phase are always present.
type SnapshotRow map[string]any
