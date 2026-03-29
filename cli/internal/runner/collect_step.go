package runner

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
)

// warnedTables tracks tables for which we've already printed a skip warning,
// so each incompatible table only warns once per process.
var warnedTables = make(map[string]bool)

// collectOnce queries all enabled pg_stat views once and appends snapshot rows
// to the provided snapshots map. The phase string is embedded in each row.
func collectOnce(ctx context.Context, pool *pgxpool.Pool, snapTables []plan.SnapTableSpec, phase string, snapshots map[string][]result.SnapshotRow) error {
	collectedAt := time.Now().UTC().Format(time.RFC3339)

	for _, spec := range snapTables {
		if spec.PgViewName == "pg_stat_statements" {
			// pg_stat_statements is collected only by its explicit step type.
			continue
		}
		if len(spec.Columns) == 0 {
			continue
		}

		quotedCols := make([]string, len(spec.Columns))
		for i, col := range spec.Columns {
			quotedCols[i] = fmt.Sprintf("%q", col)
		}
		query := fmt.Sprintf(
			"SELECT %s FROM pg_catalog.%s",
			strings.Join(quotedCols, ", "),
			spec.PgViewName,
		)

		rows, err := pool.Query(ctx, query)
		if err != nil {
			if !warnedTables[spec.PgViewName] {
				fmt.Fprintf(os.Stderr, "warning: skipping %s: %v\n", spec.PgViewName, err)
				warnedTables[spec.PgViewName] = true
			}
			continue
		}

		fieldDescs := rows.FieldDescriptions()
		for rows.Next() {
			vals, err := rows.Values()
			if err != nil {
				rows.Close()
				fmt.Fprintf(os.Stderr, "warning: scanning row from %s: %v\n", spec.PgViewName, err)
				break
			}

			row := make(result.SnapshotRow, len(vals)+2)
			row["_collected_at"] = collectedAt
			row["_phase"] = phase
			for i, fd := range fieldDescs {
				row[string(fd.Name)] = vals[i]
			}
			snapshots[spec.SnapTableName] = append(snapshots[spec.SnapTableName], row)
		}
		rows.Close()

		if err := rows.Err(); err != nil {
			fmt.Fprintf(os.Stderr, "warning: iterating rows from %s: %v\n", spec.PgViewName, err)
		}
	}

	return nil
}
