#!/usr/bin/env bash
# Fleet-cron Job 14 — env-broker policy drift check.
#
# Site containers no longer mount the fleet .env; each gets a rendered file
# holding only the keys its ops/ actually references (tools/env-broker). Two
# ways that quietly breaks:
#
#   1. A role starts using a key the policy does not grant. The role fails at
#      runtime, hours later, with an empty-variable symptom that looks like
#      anything but a credential problem.
#   2. A key stays granted after the script that needed it is gone — blast
#      radius nobody is paying for.
#
# This job detects both by re-deriving usage from the ops trees and diffing it
# against the allowlist. It also asserts each recipient's rendered file exists
# and is still 0400 (a missing one means the container is running with NO
# credentials; a loosened mode means anyone on the host can read it).
#
# DETECTION ONLY — it never re-renders. Rollouts stay deliberate.
# Healthy = SILENT, with a cooldown so a standing drift does not post daily.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/env-broker"
LOG="${ENV_BROKER_LOG:-$TOOL_DIR/env-broker.log}"
LOCK="${ENV_BROKER_LOCK:-$TOOL_DIR/.env-broker.lock}"
STAMP="$TOOL_DIR/.drift-alerted"
COOLDOWN_SEC="${ENV_BROKER_ALERT_COOLDOWN_SEC:-86400}"
LOG_MAX_BYTES="${ENV_BROKER_LOG_MAX_BYTES:-2097152}"

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

REPORT="$(cd "$DOMAINS_ROOT" && timeout 300 python3 "$TOOL_DIR/env_broker.py" --check 2>&1)"
rc=$?

# Rendered-file health. A container is a recipient if its compose mounts one --
# via a volume (sites, most tools) or env_file (fleet-dashboard). Tool composes
# are covered too: the dashboard's rendered file holds FD_TOKEN, and its absence
# would silently bring the panel back up with the gate OFF.
FILE_PROBLEMS=""
check_rendered() {
  local label="$1" f="$2" mode
  if [[ ! -f "$f" ]]; then
    FILE_PROBLEMS+="missing: $(basename "$f") — $label has NO credentials"$'\n'
    return
  fi
  mode="$(stat -c %a "$f")"
  [[ "$mode" == "400" ]] || FILE_PROBLEMS+="mode $mode (want 400): $(basename "$f")"$'\n'
}

while IFS= read -r compose; do
  domain="$(basename "$(dirname "$compose")")"
  grep -q "env-broker/rendered/" "$compose" 2>/dev/null || continue
  check_rendered "that container" "$TOOL_DIR/rendered/$domain.env"
done < <(find "$DOMAINS_ROOT/sites" -maxdepth 2 -name docker-compose.yml 2>/dev/null)

while IFS= read -r compose; do
  tool="$(basename "$(dirname "$compose")")"
  [[ "$tool" == "env-broker" ]] && continue
  grep -q "env-broker/rendered/" "$compose" 2>/dev/null || continue
  check_rendered "tools/$tool" "$TOOL_DIR/rendered/tool-$tool.env"
done < <(find "$DOMAINS_ROOT/tools" -maxdepth 2 -name docker-compose.yml 2>/dev/null)

if (( rc == 0 )) && [[ -z "$FILE_PROBLEMS" ]]; then
  log "ok — $(printf '%s' "$REPORT" | tail -1)"
  rm -f "$STAMP"
  exit 0
fi

log "DRIFT (exit $rc) — $(printf '%s' "$REPORT" | head -3 | tr '\n' ' ')"

if [[ -f "$STAMP" ]] && (( $(date +%s) - $(stat -c %Y "$STAMP") < COOLDOWN_SEC )); then
  exit 0
fi
touch "$STAMP"

if [[ -f "$DOMAINS_ROOT/.env" ]]; then
  SLACK_BOT_TOKEN="$(grep -m1 '^SLACK_BOT_TOKEN=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)"
  export SLACK_BOT_TOKEN
fi
[[ -n "${SLACK_BOT_TOKEN:-}" ]] || exit 0

timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
  --mode structured --site fleet --role env-broker --status warn \
  --headline "Site credential policy has drifted" \
  --detail "\`\`\`${REPORT:0:1500}\`\`\`" \
  ${FILE_PROBLEMS:+--detail "\`\`\`${FILE_PROBLEMS:0:800}\`\`\`"} \
  --detail "For STALE/policy drift: fix policy.yaml if needed, then \`env_broker.py render --all --restart\` — it only bounces containers whose rendered file actually changed. For MISSING/EXTRA/FORBIDDEN, fix policy.yaml first." \
  --channel-env FLEET_TEST_CHANNEL --channel-default domain-ops >/dev/null 2>&1 || true
