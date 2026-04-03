package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

const version = "0.1.0"

func main() {
	rootCmd := &cobra.Command{
		Use:   "mybench-runner",
		Short: "mybench-runner executes PostgreSQL benchmark plans exported from the mybench UI",
		Long: `mybench-runner reads a plan.json file exported from the mybench web UI,
executes the benchmark steps against PostgreSQL, and writes a result.json file.`,
		Version: version,
	}

	rootCmd.SilenceUsage = true
	rootCmd.AddCommand(newRunCmd())

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
