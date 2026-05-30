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
	pool            *pgxpool.Pool
	snapTables      []plan.SnapTableSpec
	snapshots       map[string][]result.SnapshotRow
	interval        time.Duration
	phase           string
	pgLocksEnabled  bool
	pgLocksInterval time.Duration // 0 = use interval
	done            chan struct{}
	stopped         chan struct{}
}

// NewSnapshotTicker creates a new SnapshotTicker. Call Start() to begin collection.
// pgLocksEnabled controls whether pg_locks is collected on each tick.
// pgLocksIntervalSecs sets an independent pg_locks collection interval (0 = same as intervalSecs).
func NewSnapshotTicker(
	pool *pgxpool.Pool,
	snapTables []plan.SnapTableSpec,
	snapshots map[string][]result.SnapshotRow,
	intervalSecs int,
	phase string,
	pgLocksEnabled bool,
	pgLocksIntervalSecs int,
) *SnapshotTicker {
	pgLocksInterval := time.Duration(0)
	if pgLocksIntervalSecs > 0 {
		pgLocksInterval = time.Duration(pgLocksIntervalSecs) * time.Second
	}
	return &SnapshotTicker{
		pool:            pool,
		snapTables:      snapTables,
		snapshots:       snapshots,
		interval:        time.Duration(intervalSecs) * time.Second,
		phase:           phase,
		pgLocksEnabled:  pgLocksEnabled,
		pgLocksInterval: pgLocksInterval,
		done:            make(chan struct{}),
		stopped:         make(chan struct{}),
	}
}

// Start launches the snapshot goroutine.
func (s *SnapshotTicker) Start(ctx context.Context) {
	go func() {
		defer close(s.stopped)
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()

		var lastPgLocksAt time.Time // zero = never collected

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
				if s.pgLocksEnabled {
					effectiveInterval := s.pgLocksInterval
					if effectiveInterval == 0 {
						effectiveInterval = s.interval
					}
					if lastPgLocksAt.IsZero() || time.Since(lastPgLocksAt) >= effectiveInterval {
						collectPgLocksOnce(ctx, s.pool, s.phase, s.snapshots, true)
						lastPgLocksAt = time.Now()
					}
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
