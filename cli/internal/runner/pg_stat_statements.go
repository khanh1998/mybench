package runner

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/khanh1998/mybench/cli/internal/pgconn"
	"github.com/khanh1998/mybench/cli/internal/plan"
	"github.com/khanh1998/mybench/cli/internal/result"
)

type pgStatStatementsTarget struct {
	pool     *pgxpool.Pool
	relation string
	resetFn  string
	sourceDB string
	cleanup  func()
}

func quoteIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

func findPgStatStatementsTarget(ctx context.Context, pool *pgxpool.Pool, sourceDB string) (*pgStatStatementsTarget, error) {
	var schemaName string
	err := pool.QueryRow(ctx, `
		SELECT n.nspname
		FROM pg_extension e
		JOIN pg_namespace n ON n.oid = e.extnamespace
		WHERE e.extname = 'pg_stat_statements'
		LIMIT 1
	`).Scan(&schemaName)
	if err != nil {
		return nil, err
	}

	return &pgStatStatementsTarget{
		pool:     pool,
		relation: fmt.Sprintf("%s.%s", quoteIdentifier(schemaName), quoteIdentifier("pg_stat_statements")),
		resetFn:  fmt.Sprintf("%s.%s", quoteIdentifier(schemaName), quoteIdentifier("pg_stat_statements_reset")),
		sourceDB: sourceDB,
		cleanup:  func() {},
	}, nil
}

func resolvePgStatStatementsTarget(ctx context.Context, opts RunOpts, currentPool *pgxpool.Pool) (*pgStatStatementsTarget, error) {
	target, err := findPgStatStatementsTarget(ctx, currentPool, opts.Plan.Server.Database)
	if err == nil {
		return target, nil
	}

	if opts.Plan.Server.Database == "postgres" {
		return nil, fmt.Errorf("pg_stat_statements is not installed in database %q: %w", opts.Plan.Server.Database, err)
	}

	adminPool, adminErr := pgconn.NewPool(
		ctx,
		opts.Plan.Server.Host,
		opts.Plan.Server.Port,
		opts.Plan.Server.Username,
		opts.Plan.Server.Password,
		"postgres",
		opts.Plan.Server.SSL,
	)
	if adminErr != nil {
		return nil, fmt.Errorf("pg_stat_statements is not installed in database %q, and fallback connect to postgres failed: %w", opts.Plan.Server.Database, adminErr)
	}

	target, err = findPgStatStatementsTarget(ctx, adminPool, "postgres")
	if err != nil {
		adminPool.Close()
		return nil, fmt.Errorf("pg_stat_statements is not installed in database %q or fallback database %q: %w", opts.Plan.Server.Database, "postgres", err)
	}
	target.cleanup = adminPool.Close
	return target, nil
}

func runPgStatStatementsResetStep(ctx context.Context, opts RunOpts, currentPool *pgxpool.Pool) (string, error) {
	target, err := resolvePgStatStatementsTarget(ctx, opts, currentPool)
	if err != nil {
		return "", err
	}
	defer target.cleanup()

	if _, err := target.pool.Exec(ctx, fmt.Sprintf("SELECT %s()", target.resetFn)); err != nil {
		return "", err
	}

	if target.sourceDB == opts.Plan.Server.Database {
		return fmt.Sprintf("reset pg_stat_statements using database %q", target.sourceDB), nil
	}
	return fmt.Sprintf("reset pg_stat_statements using fallback database %q for target database %q", target.sourceDB, opts.Plan.Server.Database), nil
}

func runPgStatStatementsCollectStep(
	ctx context.Context,
	opts RunOpts,
	step plan.Step,
	currentPool *pgxpool.Pool,
	snapshots map[string][]result.SnapshotRow,
) (string, error) {
	target, err := resolvePgStatStatementsTarget(ctx, opts, currentPool)
	if err != nil {
		return "", err
	}
	defer target.cleanup()

	query := fmt.Sprintf(`
		SELECT *
		FROM %s
		WHERE dbid = (SELECT oid FROM pg_database WHERE datname = $1)
	`, target.relation)
	rows, err := target.pool.Query(ctx, query, opts.Plan.Server.Database)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	fieldDescs := rows.FieldDescriptions()
	collectedAt := time.Now().UTC().Format(time.RFC3339)
	count := 0

	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return "", err
		}

		row := make(result.SnapshotRow, len(vals)+2)
		row["_collected_at"] = collectedAt
		row["_step_id"] = step.ID
		for i, fd := range fieldDescs {
			row[string(fd.Name)] = vals[i]
		}
		snapshots["snap_pg_stat_statements"] = append(snapshots["snap_pg_stat_statements"], row)
		count++
	}

	if err := rows.Err(); err != nil {
		return "", err
	}

	if target.sourceDB == opts.Plan.Server.Database {
		return fmt.Sprintf("collected %d pg_stat_statements row(s) from database %q", count, opts.Plan.Server.Database), nil
	}
	return fmt.Sprintf("collected %d pg_stat_statements row(s) for database %q using fallback database %q", count, opts.Plan.Server.Database, target.sourceDB), nil
}
