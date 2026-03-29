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
	Log        string `json:"log,omitempty"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at"`
}

// RunSummary contains the benchmark run metadata and pgbench parsed output.
type RunSummary struct {
	Status                  string       `json:"status"` // "completed", "failed", "stopped"
	StartedAt               string       `json:"started_at"`
	FinishedAt              string       `json:"finished_at,omitempty"`
	BenchStartedAt          string       `json:"bench_started_at,omitempty"`
	PostStartedAt           string       `json:"post_started_at,omitempty"`
	SnapshotIntervalSeconds int          `json:"snapshot_interval_seconds"`
	PreCollectSecs          int          `json:"pre_collect_secs"`
	PostCollectSecs         int          `json:"post_collect_secs"`
	TPS                     float64      `json:"tps,omitempty"`
	LatencyAvgMs            float64      `json:"latency_avg_ms,omitempty"`
	LatencyStddevMs         float64      `json:"latency_stddev_ms,omitempty"`
	Transactions            int64        `json:"transactions,omitempty"`
	ProfileName             string       `json:"profile_name,omitempty"`
	Params                  []RunParam   `json:"params,omitempty"`
}

// RunParam is a resolved param name-value pair as actually used for this run.
type RunParam struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// SnapshotRow is a single exported snapshot row keyed by column name.
// _collected_at is always present; time-series pg_stat_* rows also carry _phase,
// while pg_stat_statements rows carry _step_id.
type SnapshotRow map[string]any
