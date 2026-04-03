package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cwtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
)

// basicMetrics lists the 14 RDS metrics to collect from the AWS/RDS namespace.
var basicMetrics = []struct {
	Name string
	Stat string
	Unit string
}{
	{"CPUUtilization", "Average", "Percent"},
	{"FreeableMemory", "Average", "Bytes"},
	{"SwapUsage", "Average", "Bytes"},
	{"FreeStorageSpace", "Average", "Bytes"},
	{"DatabaseConnections", "Average", "Count"},
	{"ReadIOPS", "Average", "Count/Second"},
	{"WriteIOPS", "Average", "Count/Second"},
	{"ReadLatency", "Average", "Seconds"},
	{"WriteLatency", "Average", "Seconds"},
	{"ReadThroughput", "Average", "Bytes/Second"},
	{"WriteThroughput", "Average", "Bytes/Second"},
	{"NetworkReceiveThroughput", "Average", "Bytes/Second"},
	{"NetworkTransmitThroughput", "Average", "Bytes/Second"},
	{"DiskQueueDepth", "Average", "Count"},
}

// collectCloudWatchMetrics fetches RDS CloudWatch metrics for the benchmark time range.
// Returns (nil, nil) silently if AWSRegion or RDSInstanceID is not configured.
// Non-fatal: the caller should log a warning on error and continue.
func collectCloudWatchMetrics(ctx context.Context, srv plan.ServerConfig, startTime, endTime time.Time) (*result.CloudWatchResult, error) {
	if srv.AWSRegion == "" || srv.RDSInstanceID == "" {
		return nil, nil
	}

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(srv.AWSRegion))
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	cw := cloudwatch.NewFromConfig(cfg)

	// Build one MetricDataQuery per basic metric.
	queries := make([]cwtypes.MetricDataQuery, 0, len(basicMetrics))
	for i, m := range basicMetrics {
		queries = append(queries, cwtypes.MetricDataQuery{
			Id: aws.String(fmt.Sprintf("m%d", i)),
			MetricStat: &cwtypes.MetricStat{
				Metric: &cwtypes.Metric{
					Namespace:  aws.String("AWS/RDS"),
					MetricName: aws.String(m.Name),
					Dimensions: []cwtypes.Dimension{
						{
							Name:  aws.String("DBInstanceIdentifier"),
							Value: aws.String(srv.RDSInstanceID),
						},
					},
				},
				Period: aws.Int32(60),
				Stat:   aws.String(m.Stat),
			},
		})
	}

	out, err := cw.GetMetricData(ctx, &cloudwatch.GetMetricDataInput{
		MetricDataQueries: queries,
		StartTime:         aws.Time(startTime),
		EndTime:           aws.Time(endTime),
	})
	if err != nil {
		return nil, fmt.Errorf("GetMetricData: %w", err)
	}

	cwResult := &result.CloudWatchResult{}
	for _, mdr := range out.MetricDataResults {
		if mdr.Id == nil {
			continue
		}
		var idx int
		if _, err := fmt.Sscanf(aws.ToString(mdr.Id), "m%d", &idx); err != nil || idx >= len(basicMetrics) {
			continue
		}
		metricName := basicMetrics[idx].Name
		unit := basicMetrics[idx].Unit
		for j, ts := range mdr.Timestamps {
			if j >= len(mdr.Values) {
				break
			}
			cwResult.DataPoints = append(cwResult.DataPoints, result.CloudWatchDataPoint{
				MetricName: metricName,
				Timestamp:  ts.UTC().Format(time.RFC3339),
				Value:      mdr.Values[j],
				Unit:       unit,
			})
		}
	}

	// Collect Enhanced Monitoring from CloudWatch Logs (if enabled).
	// Non-fatal: if it fails we still return the basic metrics.
	emPoints, emErr := collectEnhancedMonitoring(ctx, srv, cfg, startTime, endTime)
	if emErr != nil {
		fmt.Fprintf(os.Stderr, "[WARN] enhanced monitoring collection failed: %v\n", emErr)
	} else {
		cwResult.DataPoints = append(cwResult.DataPoints, emPoints...)
	}

	return cwResult, nil
}

// emSnapshot is the parsed structure of a single Enhanced Monitoring JSON blob.
type emSnapshot struct {
	Timestamp string `json:"timestamp"`
	InstanceID string `json:"instanceID"`
	CPUUtilization struct {
		Total  float64 `json:"total"`
		User   float64 `json:"user"`
		System float64 `json:"system"`
		Wait   float64 `json:"wait"`
		Steal  float64 `json:"steal"`
		Nice   float64 `json:"nice"`
		Irq    float64 `json:"irq"`
		Guest  float64 `json:"guest"`
	} `json:"cpuUtilization"`
	LoadAverageMinute struct {
		One   float64 `json:"one"`
		Five  float64 `json:"five"`
		Fifteen float64 `json:"fifteen"`
	} `json:"loadAverageMinute"`
	Memory struct {
		Total    int64 `json:"total"`
		Free     int64 `json:"free"`
		Cached   int64 `json:"cached"`
		Active   int64 `json:"active"`
		Inactive int64 `json:"inactive"`
		Dirty    int64 `json:"dirty"`
		Buffers  int64 `json:"buffers"`
		Slab     int64 `json:"slab"`
	} `json:"memory"`
	DiskIO []struct {
		Device      string  `json:"device"`
		ReadKbPS    float64 `json:"readKbPS"`
		WriteKbPS   float64 `json:"writeKbPS"`
		ReadIOsPS   float64 `json:"readIOsPS"`
		WriteIOsPS  float64 `json:"writeIOsPS"`
		Await       float64 `json:"await"`
		Util        float64 `json:"util"`
		AvgQueueLen float64 `json:"avgQueueLen"`
		TPS         float64 `json:"tps"`
	} `json:"diskIO"`
	Network []struct {
		Interface string  `json:"interface"`
		Rx        float64 `json:"rx"`
		Tx        float64 `json:"tx"`
	} `json:"network"`
	FileSys []struct {
		Name        string  `json:"name"`
		Used        int64   `json:"used"`
		Total       int64   `json:"total"`
		UsedPercent float64 `json:"usedPercent"`
	} `json:"fileSys"`
}

// collectEnhancedMonitoring reads Enhanced Monitoring snapshots from CloudWatch Logs
// (RDSOSMetrics log group) for the benchmark time range and flattens them into
// CloudWatchDataPoints with an "em_" prefix.
func collectEnhancedMonitoring(ctx context.Context, srv plan.ServerConfig, cfg aws.Config, startTime, endTime time.Time) ([]result.CloudWatchDataPoint, error) {
	if !srv.EnhancedMonitoring {
		return nil, nil
	}

	cwl := cloudwatchlogs.NewFromConfig(cfg)

	startMs := startTime.UnixMilli()
	endMs := endTime.UnixMilli()

	// FilterLogEvents with JSON pattern to match only this instance.
	filterPattern := fmt.Sprintf(`{ $.instanceID = "%s" }`, srv.RDSInstanceID)
	var points []result.CloudWatchDataPoint
	var nextToken *string

	for {
		out, err := cwl.FilterLogEvents(ctx, &cloudwatchlogs.FilterLogEventsInput{
			LogGroupName:  aws.String("RDSOSMetrics"),
			StartTime:     aws.Int64(startMs),
			EndTime:       aws.Int64(endMs),
			FilterPattern: aws.String(filterPattern),
			NextToken:     nextToken,
		})
		if err != nil {
			return nil, fmt.Errorf("FilterLogEvents: %w", err)
		}

		for _, ev := range out.Events {
			if ev.Message == nil {
				continue
			}
			var snap emSnapshot
			if err := json.Unmarshal([]byte(*ev.Message), &snap); err != nil {
				continue
			}
			ts := snap.Timestamp
			if ts == "" {
				continue
			}

			add := func(name string, value float64, unit string) {
				points = append(points, result.CloudWatchDataPoint{
					MetricName: name, Timestamp: ts, Value: value, Unit: unit,
				})
			}

			// CPU
			add("em_cpu_total",  snap.CPUUtilization.Total,  "Percent")
			add("em_cpu_user",   snap.CPUUtilization.User,   "Percent")
			add("em_cpu_system", snap.CPUUtilization.System, "Percent")
			add("em_cpu_wait",   snap.CPUUtilization.Wait,   "Percent")
			add("em_cpu_steal",  snap.CPUUtilization.Steal,  "Percent")
			add("em_cpu_nice",   snap.CPUUtilization.Nice,   "Percent")

			// Load average
			add("em_load_1m",  snap.LoadAverageMinute.One,     "Count")
			add("em_load_5m",  snap.LoadAverageMinute.Five,    "Count")
			add("em_load_15m", snap.LoadAverageMinute.Fifteen, "Count")

			// Memory (KB → Bytes)
			add("em_memory_free",     float64(snap.Memory.Free)*1024,     "Bytes")
			add("em_memory_cached",   float64(snap.Memory.Cached)*1024,   "Bytes")
			add("em_memory_active",   float64(snap.Memory.Active)*1024,   "Bytes")
			add("em_memory_dirty",    float64(snap.Memory.Dirty)*1024,    "Bytes")
			add("em_memory_buffers",  float64(snap.Memory.Buffers)*1024,  "Bytes")
			add("em_memory_total",    float64(snap.Memory.Total)*1024,    "Bytes")

			// Disk IO per device
			for _, d := range snap.DiskIO {
				dev := strings.ReplaceAll(d.Device, " ", "_")
				add("em_disk_"+dev+"_read_kbps",  d.ReadKbPS,    "KB/s")
				add("em_disk_"+dev+"_write_kbps", d.WriteKbPS,   "KB/s")
				add("em_disk_"+dev+"_read_iops",  d.ReadIOsPS,   "Count/Second")
				add("em_disk_"+dev+"_write_iops", d.WriteIOsPS,  "Count/Second")
				add("em_disk_"+dev+"_await",      d.Await,       "ms")
				add("em_disk_"+dev+"_util",        d.Util,        "Percent")
				add("em_disk_"+dev+"_queue_len",   d.AvgQueueLen, "Count")
			}

			// Network per interface (KB/s)
			for _, n := range snap.Network {
				iface := strings.ReplaceAll(n.Interface, " ", "_")
				add("em_net_"+iface+"_rx", n.Rx, "KB/s")
				add("em_net_"+iface+"_tx", n.Tx, "KB/s")
			}

			// Filesystem
			for _, f := range snap.FileSys {
				name := strings.ReplaceAll(f.Name, " ", "_")
				add("em_fs_"+name+"_used_pct", f.UsedPercent,           "Percent")
				add("em_fs_"+name+"_used",     float64(f.Used)*1024,    "Bytes")
				add("em_fs_"+name+"_total",    float64(f.Total)*1024,   "Bytes")
			}
		}

		if out.NextToken == nil {
			break
		}
		nextToken = out.NextToken
	}

	return points, nil
}
