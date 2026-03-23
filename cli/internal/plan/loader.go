package plan

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// ReadPlan reads and parses a plan.json file from the given path.
func ReadPlan(path string) (*Plan, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading plan file: %w", err)
	}

	var p Plan
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("parsing plan JSON: %w", err)
	}

	if p.Version != 1 {
		return nil, fmt.Errorf("unsupported plan version: %d (expected 1)", p.Version)
	}

	return &p, nil
}

// ApplyParamOverrides applies the given overrides map to the plan's params.
// If a param with a matching name already exists, its value is replaced.
// If no matching param exists, a new one is appended.
func ApplyParamOverrides(p *Plan, overrides map[string]string) {
	for key, val := range overrides {
		found := false
		for i, param := range p.Params {
			if param.Name == key {
				p.Params[i].Value = val
				found = true
				break
			}
		}
		if !found {
			p.Params = append(p.Params, Param{Name: key, Value: val})
		}
	}
}

// SubstituteParams replaces {{NAME}} placeholders in a script string with
// the values from the plan's params list.
func SubstituteParams(script string, params []Param) string {
	for _, p := range params {
		script = strings.ReplaceAll(script, "{{"+p.Name+"}}", p.Value)
	}
	return script
}
