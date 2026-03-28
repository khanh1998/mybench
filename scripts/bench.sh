#!/usr/bin/env bash
# bench.sh — Download plan from local mybench, run on EC2, import result back
#
# Usage:
#   ./scripts/bench.sh [OPTIONS]
#
# Options:
#   -d, --design   <id>          Design ID to benchmark (default: 1)
#   -h, --host     <user@host>   EC2 SSH target (default: ec2-user@<EC2_HOST>)
#   -k, --key      <path>        SSH key file (default: ~/.ssh/id_rsa)
#   -r, --remote   <path>        Remote working dir on EC2 (default: ~/mybench-bench)
#   -u, --ui       <url>         Local mybench URL (default: http://localhost:5173)
#   -p, --param    KEY=VALUE     Override plan param (repeatable)
#       --profile  <name>        Apply a named parameter profile from the plan
#       --progress               Show pgbench progress output on EC2
#       --log-dir  <path>        Remote dir for pgbench log files (default: /tmp/mybench-logs)
#       --build                  Build and sync the Go CLI to EC2 (skipped by default)
#       --dry-run                Print steps without executing

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
DESIGN_ID=1
EC2_HOST="${EC2_HOST:-}"          # fallback: set EC2_HOST env var or pass --host
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_DIR="~/mybench-bench"
LOCAL_UI="http://localhost:5173"
PARAMS=()
PROFILE=""
PROGRESS=false
LOG_DIR="/tmp/mybench-logs"
BUILD_CLI=false
DRY_RUN=false

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMPLE_DIR="$REPO_ROOT/sample-plan"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[bench]${NC} $*"; }
success() { echo -e "${GREEN}[bench]${NC} $*"; }
warn()    { echo -e "${YELLOW}[bench]${NC} $*"; }
die()     { echo -e "${RED}[bench] ERROR:${NC} $*" >&2; exit 1; }

# ── Arg parse ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--design)    DESIGN_ID="$2"; shift 2 ;;
    -h|--host)      EC2_HOST="$2";  shift 2 ;;
    -k|--key)       SSH_KEY="$2";   shift 2 ;;
    -r|--remote)    REMOTE_DIR="$2"; shift 2 ;;
    -u|--ui)        LOCAL_UI="$2";  shift 2 ;;
    -p|--param)     PARAMS+=("$2"); shift 2 ;;
    --profile)      PROFILE="$2";   shift 2 ;;
    --progress)     PROGRESS=true;  shift   ;;
    --log-dir)      LOG_DIR="$2";   shift 2 ;;
    --build)        BUILD_CLI=true; shift   ;;
    --dry-run)      DRY_RUN=true;   shift   ;;
    --help)
      sed -n '/^# bench.sh/,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -z "$EC2_HOST" ]] && die "EC2 host not set. Use --host user@hostname or export EC2_HOST=user@hostname"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o BatchMode=yes)
run() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[dry-run]${NC} $*"
  else
    "$@"
  fi
}
ssh_run() {
  run ssh "${SSH_OPTS[@]}" "$EC2_HOST" "$@"
}

# ── Step 1: Export plan from local mybench UI ─────────────────────────────────
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PLAN_FILE="$SAMPLE_DIR/design-${DESIGN_ID}-plan.json"

info "Step 1/5 — Exporting design $DESIGN_ID from $LOCAL_UI …"
run curl -sf "$LOCAL_UI/api/designs/$DESIGN_ID/export" -o "$PLAN_FILE" \
  || die "Failed to download plan from $LOCAL_UI/api/designs/$DESIGN_ID/export\n  Is mybench running? (npm run dev)"
success "Plan saved → $PLAN_FILE"

# ── Step 2: Build + sync Go CLI (optional) ────────────────────────────────────
CLI_BIN="$REPO_ROOT/bin/mybench-runner-linux"
REMOTE_BIN="$REMOTE_DIR/mybench-runner"

if $BUILD_CLI; then
  info "Step 2/5 — Building Go CLI for linux/amd64 …"
  run env GOOS=linux GOARCH=amd64 \
    go build -C "$REPO_ROOT/cli" -o "$CLI_BIN" ./cmd/... \
    || die "Go build failed"
  success "Binary → $CLI_BIN"

  info "       Syncing binary to EC2 …"
  ssh_run "mkdir -p $REMOTE_DIR"
  run scp "${SSH_OPTS[@]}" "$CLI_BIN" "$EC2_HOST:$REMOTE_BIN"
  ssh_run "chmod +x $REMOTE_BIN"
  success "Binary synced → EC2:$REMOTE_BIN"
else
  info "Step 2/5 — Skipping CLI build/sync (use --build to rebuild)"
fi

# ── Step 3: Sync plan to EC2 ───────────────────────────────────────────────────
REMOTE_PLAN="$REMOTE_DIR/design-${DESIGN_ID}-plan.json"

info "Step 3/5 — Syncing plan to EC2 ($EC2_HOST:$REMOTE_DIR) …"
ssh_run "mkdir -p $REMOTE_DIR"
run scp "${SSH_OPTS[@]}" "$PLAN_FILE" "$EC2_HOST:$REMOTE_PLAN"
success "Plan synced"

# ── Step 4: Run benchmark on EC2 ──────────────────────────────────────────────
RESULT_REMOTE="$REMOTE_DIR/design-${DESIGN_ID}-plan-result-${TIMESTAMP}.json"

# Build CLI args
CLI_ARGS=(
  "$REMOTE_BIN" run
  "--output" "$RESULT_REMOTE"
  "--log-dir" "$LOG_DIR"
)
if [[ -n "$PROFILE" ]]; then
  CLI_ARGS+=(--profile "$PROFILE")
fi
if [[ ${#PARAMS[@]} -gt 0 ]]; then
  for kv in "${PARAMS[@]}"; do
    CLI_ARGS+=(--param "$kv")
  done
fi
$PROGRESS && CLI_ARGS+=(--progress)

# Verify binary exists on EC2
if ! $DRY_RUN; then
  ssh "${SSH_OPTS[@]}" "$EC2_HOST" "test -x $REMOTE_BIN" \
    || die "Binary not found on EC2 at $REMOTE_BIN\n  Run with --build to compile and sync it first."
fi

info "Step 4/5 — Running benchmark on EC2 …"
[[ -n "$PROFILE" ]] && info "  Profile: $PROFILE"
[[ ${#PARAMS[@]} -gt 0 ]] && info "  Param overrides: ${PARAMS[*]}"
info "  Result will be written to EC2:$RESULT_REMOTE"

BENCH_EXIT=0
if $DRY_RUN; then
  echo -e "${YELLOW}[dry-run]${NC} ssh ${SSH_OPTS[*]} $EC2_HOST ${CLI_ARGS[*]} $REMOTE_PLAN"
else
  ssh "${SSH_OPTS[@]}" "$EC2_HOST" "${CLI_ARGS[@]}" "$REMOTE_PLAN" || BENCH_EXIT=$?
fi

if [[ $BENCH_EXIT -ne 0 ]]; then
  warn "Benchmark exited with code $BENCH_EXIT — will still attempt to download and import the result"
else
  success "Benchmark complete"
fi

# ── Step 5: Download result + import ──────────────────────────────────────────
RESULT_LOCAL="$SAMPLE_DIR/design-${DESIGN_ID}-result-ec2-${TIMESTAMP}.json"

info "Step 5/5 — Downloading result from EC2 …"
run scp "${SSH_OPTS[@]}" "$EC2_HOST:$RESULT_REMOTE" "$RESULT_LOCAL"
success "Result saved → $RESULT_LOCAL"

info "Importing result into local mybench …"
# Build import payload as a temp file to avoid ARG_MAX limits on large result JSON
IMPORT_PAYLOAD="$(mktemp /tmp/mybench-import-XXXXXX.json)"
python3 -c "
import json, sys
result = json.load(open('$RESULT_LOCAL'))
print(json.dumps({'design_id': $DESIGN_ID, 'result': result}))
" > "$IMPORT_PAYLOAD"
IMPORT_RESPONSE=$(
  run curl -sf -X POST "$LOCAL_UI/api/runs/import" \
    -H "Content-Type: application/json" \
    -d "@$IMPORT_PAYLOAD" \
  || die "Import POST failed — is mybench running at $LOCAL_UI?"
)
rm -f "$IMPORT_PAYLOAD"

RUN_ID=$(echo "$IMPORT_RESPONSE" | grep -o '"run_id":[0-9]*' | grep -o '[0-9]*')
if [[ -n "$RUN_ID" ]]; then
  success "Run imported! run_id=$RUN_ID"
  echo ""
  echo -e "  ${GREEN}View result:${NC} $LOCAL_UI/designs/$DESIGN_ID/runs/$RUN_ID"
else
  warn "Import response: $IMPORT_RESPONSE"
  die "Could not parse run_id from import response"
fi
