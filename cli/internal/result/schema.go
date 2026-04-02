package result

// Result is the top-level structure written to result.json.
type Result struct {
	Version       int                      `json:"version"`
	DesignID      int                      `json:"design_id"`
	RunnerVersion string                   `json:"runner_version"`
	Run           RunSummary               `json:"run"`
	Steps         []StepResult             `json:"steps"`
	Snapshots     map[string][]SnapshotRow `json:"snapshots"`
}

// StepResult records execution metadata for a single step.
type StepResult struct {
	StepID          int                   `json:"step_id"`
	Position        int                   `json:"position"`
	Name            string                `json:"name"`
	Type            string                `json:"type"`
	Status          string                `json:"status"` // "completed" or "failed"
	Command         string                `json:"command,omitempty"`
	Log             string                `json:"log,omitempty"`
	ProcessedScript string                `json:"processed_script,omitempty"`
	PgbenchSummary  *PgbenchSummary       `json:"pgbench_summary,omitempty"`
	PgbenchScripts  []PgbenchScriptResult `json:"pgbench_scripts,omitempty"`
	StartedAt       string                `json:"started_at"`
	FinishedAt      string                `json:"finished_at"`
}

type PgbenchSummary struct {
	TPS                     float64  `json:"tps"`
	LatencyAvgMs            float64  `json:"latency_avg_ms"`
	LatencyStddevMs         float64  `json:"latency_stddev_ms"`
	Transactions            int64    `json:"transactions"`
	FailedTransactions      int64    `json:"failed_transactions"`
	TransactionType         *string  `json:"transaction_type,omitempty"`
	ScalingFactor           *int     `json:"scaling_factor,omitempty"`
	QueryMode               *string  `json:"query_mode,omitempty"`
	NumberOfClients         *int     `json:"number_of_clients,omitempty"`
	NumberOfThreads         *int     `json:"number_of_threads,omitempty"`
	MaximumTries            *int     `json:"maximum_tries,omitempty"`
	DurationSecs            *int     `json:"duration_secs,omitempty"`
	InitialConnectionTimeMs *float64 `json:"initial_connection_time_ms,omitempty"`
}

type PgbenchScriptResult struct {
	Position           int     `json:"position"`
	Name               string  `json:"name"`
	Weight             int     `json:"weight"`
	Script             string  `json:"script,omitempty"`
	TPS                float64 `json:"tps"`
	LatencyAvgMs       float64 `json:"latency_avg_ms"`
	LatencyStddevMs    float64 `json:"latency_stddev_ms"`
	Transactions       int64   `json:"transactions"`
	FailedTransactions int64   `json:"failed_transactions"`
}

// RunSummary contains the benchmark run metadata and pgbench parsed output.
type RunSummary struct {
	Status                  string     `json:"status"` // "completed", "failed", "stopped"
	StartedAt               string     `json:"started_at"`
	FinishedAt              string     `json:"finished_at,omitempty"`
	BenchStartedAt          string     `json:"bench_started_at,omitempty"`
	PostStartedAt           string     `json:"post_started_at,omitempty"`
	SnapshotIntervalSeconds int        `json:"snapshot_interval_seconds"`
	PreCollectSecs          int        `json:"pre_collect_secs"`
	PostCollectSecs         int        `json:"post_collect_secs"`
	TPS                     float64    `json:"tps,omitempty"`
	LatencyAvgMs            float64    `json:"latency_avg_ms,omitempty"`
	LatencyStddevMs         float64    `json:"latency_stddev_ms,omitempty"`
	Transactions            int64      `json:"transactions,omitempty"`
	ProfileName             string     `json:"profile_name,omitempty"`
	Params                  []RunParam `json:"params,omitempty"`
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
