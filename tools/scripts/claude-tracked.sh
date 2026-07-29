#!/usr/bin/env bash
# claude-tracked.sh: drop-in wrapper around `claude -p` that records real
# token usage/cost for the Fleet Dashboard AI Usage tab.
#
# Usage: identical to a normal `claude -p` invocation, e.g.
#   claude-tracked.sh "$PROMPT" --max-turns 15 --dangerously-skip-permissions --model claude-sonnet-4-6
#
# Requires two env vars from the caller (both already known at every
# call site — repo basename / the role name run-role.sh is dispatching):
#   CRON_SITE   e.g. americastrikes.com
#   CRON_ROLE   e.g. affiliate-editor
# Optional:
#   REPO_ROOT   defaults to $(pwd) — used to locate ops/logs/
#
# Behavior:
#   - Runs the real `claude` binary with any caller-supplied flags, but forces
#     --output-format json (any --output-format the caller passed is ignored/
#     overridden) so usage/cost survive.
#   - Prints .result to stdout, so existing `>> "$LOG"` / `| tee -a "$LOG"`
#     callers see the same human-readable text they saw with --output-format text.
#   - Appends one JSON line to ops/logs/token-usage-<UTC date>.jsonl with
#     site, role, model, token counts, cost, duration, and turn count.
#   - Exits with the real `claude` exit code.

set -euo pipefail

if [[ -z "${CRON_SITE:-}" || -z "${CRON_ROLE:-}" ]]; then
  echo "claude-tracked.sh: CRON_SITE and CRON_ROLE must be exported by the caller" >&2
  exit 64
fi

REPO_ROOT="${REPO_ROOT:-$(pwd)}"
LOG_DIR="$REPO_ROOT/ops/logs"
mkdir -p "$LOG_DIR"
LEDGER="$LOG_DIR/token-usage-$(date -u +%Y-%m-%d).jsonl"

# Strip any --output-format (and its value) the caller passed — we own that flag.
ARGS=()
skip_next=0
for arg in "$@"; do
  if [[ $skip_next -eq 1 ]]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    --output-format)
      skip_next=1
      continue
      ;;
    --output-format=*)
      continue
      ;;
  esac
  ARGS+=("$arg")
done

TMP_JSON="$(mktemp)"
trap 'rm -f "$TMP_JSON"' EXIT

set +e
claude -p "${ARGS[@]}" --output-format json > "$TMP_JSON"
STATUS=$?
set -e

python3 - "$TMP_JSON" "$LEDGER" "$CRON_SITE" "$CRON_ROLE" "$STATUS" <<'PYEOF'
import json
import sys
import time

tmp_path, ledger_path, site, role, status = sys.argv[1:6]

try:
    with open(tmp_path, encoding="utf-8") as fh:
        raw = fh.read()
    data = json.loads(raw)
except (OSError, json.JSONDecodeError):
    data = None

if data is not None:
    sys.stdout.write(data.get("result", ""))
    usage = data.get("usage", {}) or {}
    model_usage = data.get("modelUsage", {}) or {}
    model = next(iter(model_usage), None) or data.get("model")
    record = {
        "recorded_at_unix": int(time.time()),
        "site": site,
        "role": role,
        "model": model,
        "subtype": data.get("subtype"),
        "is_error": data.get("is_error"),
        "exit_status": int(status),
        "num_turns": data.get("num_turns"),
        "duration_ms": data.get("duration_ms"),
        "total_cost_usd": data.get("total_cost_usd"),
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
        "session_id": data.get("session_id"),
    }
else:
    # claude produced no parseable JSON (crash, timeout kill, etc). Still
    # record the attempt so the ledger reflects failed calls, not silence.
    record = {
        "recorded_at_unix": int(time.time()),
        "site": site,
        "role": role,
        "model": None,
        "subtype": "parse_error",
        "is_error": True,
        "exit_status": int(status),
        "num_turns": None,
        "duration_ms": None,
        "total_cost_usd": None,
        "input_tokens": None,
        "output_tokens": None,
        "cache_creation_input_tokens": None,
        "cache_read_input_tokens": None,
        "session_id": None,
    }

with open(ledger_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF

exit "$STATUS"
