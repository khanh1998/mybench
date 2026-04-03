package plan

// Plan is the top-level structure parsed from plan.json.
type Plan struct {
	Version           int             `json:"version"`
	ExportedAt        string          `json:"exported_at"`
	DesignID          int             `json:"design_id"`
	DesignName        string          `json:"design_name"`
	Server            ServerConfig    `json:"server"`
	RunSettings       RunSettings     `json:"run_settings"`
	Params            []Param         `json:"params"`
	Profiles          []Profile       `json:"profiles,omitempty"`
	ProfileName       string          `json:"profile_name,omitempty"`
	Steps             []Step          `json:"steps"`
	EnabledSnapTables []SnapTableSpec `json:"enabled_snap_tables"`
}

// Profile is a named set of param overrides exported from the web UI.
type Profile struct {
	Name   string         `json:"name"`
	Values []ProfileValue `json:"values"`
}

// ProfileValue is a single param override within a profile.
type ProfileValue struct {
	ParamName string `json:"param_name"`
	Value     string `json:"value"`
}

// ServerConfig holds the PostgreSQL connection parameters and optional AWS/RDS config.
type ServerConfig struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	Password           string `json:"password"`
	Database           string `json:"database"`
	SSL                bool   `json:"ssl"`
	AWSRegion          string `json:"aws_region"`
	RDSInstanceID      string `json:"rds_instance_id"`
	EnhancedMonitoring bool   `json:"enhanced_monitoring"`
}

// RunSettings holds timing configuration for snapshot collection.
type RunSettings struct {
	SnapshotIntervalSeconds int `json:"snapshot_interval_seconds"`
	PreCollectSecs          int `json:"pre_collect_secs"`
	PostCollectSecs         int `json:"post_collect_secs"`
}

// Param is a named key-value pair for template substitution.
type Param struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Step represents one step in the benchmark plan.
type Step struct {
	ID              int             `json:"id"`
	Position        int             `json:"position"`
	Name            string          `json:"name"`
	Type            string          `json:"type"` // "sql", "pgbench", "collect", "pg_stat_statements_reset", "pg_stat_statements_collect"
	Enabled         bool            `json:"enabled"`
	Script          string          `json:"script,omitempty"`
	NoTransaction   bool            `json:"no_transaction,omitempty"`
	DurationSecs    int             `json:"duration_secs,omitempty"`
	PgbenchOptions  string          `json:"pgbench_options,omitempty"`
	PgbenchScripts  []PgbenchScript `json:"pgbench_scripts,omitempty"`
}

// PgbenchScript is a named pgbench custom script with a weight.
type PgbenchScript struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Weight int    `json:"weight"`
	Script string `json:"script"`
}

// SnapTableSpec describes which pg_stat view to collect and which columns to select.
type SnapTableSpec struct {
	PgViewName    string   `json:"pg_view_name"`
	SnapTableName string   `json:"snap_table_name"`
	Columns       []string `json:"columns"`
}
