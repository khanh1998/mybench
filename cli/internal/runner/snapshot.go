package runner

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
)

// SnapshotTicker periodically calls collectOnce on an interval until stopped.
type SnapshotTicker struct {
	pool      *pgxpool.Pool
	snapTables []plan.SnapTableSpec
	snapshots map[string][]result.SnapshotRow
	interval  time.Duration
	phase     string
	done      chan struct{}
	stopped   chan struct{}
}

// NewSnapshotTicker creates a new SnapshotTicker. Call Start() to begin collection.
func NewSnapshotTicker(
	pool *pgxpool.Pool,
	snapTables []plan.SnapTableSpec,
	snapshots map[string][]result.SnapshotRow,
	intervalSecs int,
	phase string,
) *SnapshotTicker {
	return &SnapshotTicker{
		pool:       pool,
		snapTables: snapTables,
		snapshots:  snapshots,
		interval:   time.Duration(intervalSecs) * time.Second,
		phase:      phase,
		done:       make(chan struct{}),
		stopped:    make(chan struct{}),
	}
}

// Start launches the snapshot goroutine.
func (s *SnapshotTicker) Start(ctx context.Context) {
	go func() {
		defer close(s.stopped)
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()

		for {
			select {
			case <-s.done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := collectOnce(ctx, s.pool, s.snapTables, s.phase, s.snapshots); err != nil {
					fmt.Printf("warning: snapshot collection error: %v\n", err)
				}
			}
		}
	}()
}

// Stop signals the goroutine to stop and waits for it to finish.
func (s *SnapshotTicker) Stop() {
	close(s.done)
	<-s.stopped
}
