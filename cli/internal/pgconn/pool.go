package pgconn

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool creates a pgxpool.Pool from the given connection parameters.
// If password is empty, the user is prompted to enter it via stdin.
func NewPool(ctx context.Context, host string, port int, username, password, database string, ssl bool) (*pgxpool.Pool, error) {
	if password == "" {
		prompted, err := promptPassword(username, host)
		if err != nil {
			return nil, fmt.Errorf("prompting for password: %w", err)
		}
		password = prompted
	}

	sslMode := "disable"
	if ssl {
		sslMode = "require"
	}

	dsn := fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		host, port, username, password, database, sslMode,
	)

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing connection string: %w", err)
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", err)
	}

	// Verify connectivity.
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}

	return pool, nil
}

// promptPassword reads a password from stdin with a prompt.
func promptPassword(username, host string) (string, error) {
	fmt.Fprintf(os.Stderr, "Password for %s@%s: ", username, host)
	reader := bufio.NewReader(os.Stdin)
	pw, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimRight(pw, "\r\n"), nil
}
