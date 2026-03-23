package runner

import (
	"fmt"
	"io"
	"os"
	"os/exec"
)

// runSQLStep writes the script to a .sql file, then spawns psql to execute it.
// Stdout+stderr go to a .log file. If progress is true, output is also tee'd to terminal.
// Returns an error if psql exits with a non-zero exit code.
func runSQLStep(opts RunOpts, stepName string, script string, noTransaction bool) error {
	sqlFile, logFile, err := prepareStepFiles(opts.LogDir, opts.Timestamp, stepName, "sql")
	if err != nil {
		return err
	}

	if err := os.WriteFile(sqlFile, []byte(script), 0644); err != nil {
		return fmt.Errorf("writing sql script: %w", err)
	}

	server := opts.Plan.Server

	args := []string{
		"-h", server.Host,
		"-p", fmt.Sprintf("%d", server.Port),
		"-U", server.Username,
		"-d", server.Database,
		"-v", "ON_ERROR_STOP=1",
		"--no-psqlrc",
	}
	if !noTransaction {
		args = append(args, "--single-transaction")
	}
	args = append(args, "-f", sqlFile)

	cmd := exec.Command("psql", args...)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+server.Password)

	logFH, err := os.Create(logFile)
	if err != nil {
		return fmt.Errorf("creating log file: %w", err)
	}
	defer logFH.Close()

	var out io.Writer = logFH
	if opts.Progress {
		out = io.MultiWriter(logFH, os.Stdout)
	}
	cmd.Stdout = out
	cmd.Stderr = out

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("psql exited with error: %w", err)
	}
	return nil
}
