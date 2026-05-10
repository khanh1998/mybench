package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
)

const version = "0.1.0"

func main() {
	// Ignore SIGPIPE so writes to a dead SSH stdout don't kill the process.
	// Without this, the Go CLI dies immediately when the SSH connection drops
	// and it tries to emit a __MB__ event — leaving runs incomplete and result
	// files unwritten.
	signal.Ignore(syscall.SIGPIPE)

	rootCmd := &cobra.Command{
		Use:   "mybench-runner",
		Short: "mybench-runner executes PostgreSQL benchmark plans exported from the mybench UI",
		Long: `mybench-runner reads a plan.json file exported from the mybench web UI,
executes the benchmark steps against PostgreSQL, and writes a result.json file.`,
		Version: version,
	}

	rootCmd.SilenceUsage = true
	rootCmd.AddCommand(newRunCmd())
	rootCmd.AddCommand(newSeriesCmd())

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

