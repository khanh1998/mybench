package plan

import (
	"testing"
)

func TestApplyParamOverrides_ReplaceExisting(t *testing.T) {
	p := &Plan{
		Params: []Param{
			{Name: "NUM", Value: "1000"},
			{Name: "OTHER", Value: "unchanged"},
		},
	}
	ApplyParamOverrides(p, map[string]string{"NUM": "50"})

	if len(p.Params) != 2 {
		t.Fatalf("expected 2 params, got %d", len(p.Params))
	}
	if p.Params[0].Value != "50" {
		t.Errorf("expected NUM=50, got NUM=%s", p.Params[0].Value)
	}
	if p.Params[1].Value != "unchanged" {
		t.Errorf("expected OTHER=unchanged, got OTHER=%s", p.Params[1].Value)
	}
}

func TestApplyParamOverrides_AddNew(t *testing.T) {
	p := &Plan{
		Params: []Param{
			{Name: "EXISTING", Value: "val"},
		},
	}
	ApplyParamOverrides(p, map[string]string{"NEWKEY": "newval"})

	if len(p.Params) != 2 {
		t.Fatalf("expected 2 params, got %d", len(p.Params))
	}
	found := false
	for _, param := range p.Params {
		if param.Name == "NEWKEY" && param.Value == "newval" {
			found = true
		}
	}
	if !found {
		t.Error("expected NEWKEY=newval to be appended to params")
	}
}

func TestApplyParamOverrides_Multiple(t *testing.T) {
	p := &Plan{
		Params: []Param{
			{Name: "A", Value: "1"},
			{Name: "B", Value: "2"},
		},
	}
	ApplyParamOverrides(p, map[string]string{
		"A": "10",
		"B": "20",
		"C": "30",
	})

	if len(p.Params) != 3 {
		t.Fatalf("expected 3 params, got %d", len(p.Params))
	}

	vals := map[string]string{}
	for _, param := range p.Params {
		vals[param.Name] = param.Value
	}

	if vals["A"] != "10" {
		t.Errorf("expected A=10, got A=%s", vals["A"])
	}
	if vals["B"] != "20" {
		t.Errorf("expected B=20, got B=%s", vals["B"])
	}
	if vals["C"] != "30" {
		t.Errorf("expected C=30, got C=%s", vals["C"])
	}
}

func TestSubstituteParams(t *testing.T) {
	params := []Param{
		{Name: "SCALE", Value: "100"},
		{Name: "CLIENTS", Value: "50"},
	}
	script := "pgbench -s {{SCALE}} -c {{CLIENTS}} mydb"
	result := SubstituteParams(script, params)
	expected := "pgbench -s 100 -c 50 mydb"
	if result != expected {
		t.Errorf("expected %q, got %q", expected, result)
	}
}

func TestSubstituteParams_NoMatch(t *testing.T) {
	params := []Param{
		{Name: "OTHER", Value: "val"},
	}
	script := "no placeholders here"
	result := SubstituteParams(script, params)
	if result != script {
		t.Errorf("expected script unchanged, got %q", result)
	}
}
