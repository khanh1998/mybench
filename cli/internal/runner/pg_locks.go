package runner

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/khanh1998/mybench/cli/internal/result"
)

const pgLocksSnapTable = "snap_pg_locks"

var warnedPgLocks bool

// collectPgLocksOnce queries pg_locks and appends snapshot rows to snapshots["snap_pg_locks"].
// Errors are non-fatal: a single warning is printed and the function returns silently.
func collectPgLocksOnce(ctx context.Context, pool *pgxpool.Pool, phase string, snapshots map[string][]result.SnapshotRow) {
	const query = `
		SELECT locktype,
		       database, relation, page, tuple,
		       virtualxid, transactionid::text,
		       classid, objid, objsubid,
		       virtualtransaction, pid, mode,
		       granted::int, fastpath::int
		FROM pg_catalog.pg_locks
		WHERE pid IS NOT NULL`

	rows, err := pool.Query(ctx, query)
	if err != nil {
		if !warnedPgLocks {
			fmt.Fprintf(os.Stderr, "warning: skipping pg_locks snapshot: %v\n", err)
			warnedPgLocks = true
		}
		return
	}
	defer rows.Close()

	collectedAt := time.Now().UTC().Format(time.RFC3339)
	fieldDescs := rows.FieldDescriptions()

	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: scanning pg_locks row: %v\n", err)
			break
		}
		row := make(result.SnapshotRow, len(vals)+2)
		row["_collected_at"] = collectedAt
		row["_phase"] = phase
		for i, fd := range fieldDescs {
			row[string(fd.Name)] = vals[i]
		}
		snapshots[pgLocksSnapTable] = append(snapshots[pgLocksSnapTable], row)
	}

	if err := rows.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: iterating pg_locks rows: %v\n", err)
	}
}
