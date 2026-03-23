package result

import (
	"encoding/json"
	"fmt"
	"os"
)

// WriteResult serializes result to JSON and writes it to path.
// The file is written atomically by first writing to a temp file and renaming,
// so partial writes due to SIGINT are avoided for the normal case.
// For partial writes on signal, call WriteResult directly without the rename trick
// (the caller handles this by calling WriteResult from a signal handler).
func WriteResult(path string, r *Result) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling result: %w", err)
	}

	// Write to a temp file first, then rename for atomicity.
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("writing result temp file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		// Rename may fail if source and destination are on different filesystems.
		// Fall back to direct write.
		_ = os.Remove(tmpPath)
		if err2 := os.WriteFile(path, data, 0644); err2 != nil {
			return fmt.Errorf("writing result file: %w", err2)
		}
	}

	return nil
}
