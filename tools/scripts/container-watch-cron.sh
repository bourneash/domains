#!/usr/bin/env bash
# Host-wide container watchdog (tools/container-watch/check_containers.py).
#
# Healthy = SILENT on Slack, same contract as the lint/test/git-hygiene sweeps.
# It speaks only when the finding set CHANGES — a container that has been
# unhealthy for a week should not re-alert every hour, or the alert becomes
# background noise and the next real one is skipped. State lives beside the
# tool; the first run after a state reset reports whatever it finds.
#
# Deliberately host-wide, NOT scoped to this repo: the Fleet Dashboard's
# Containers tab filters to compose projects inside the domains checkout, which
# is why an Exited(255) container from another project sat dead for six days
# with nothing reporting it (B11).
#
# Install (fleet-cron crontab.docker):
#   23 * * * * /home/jesse/projects/domains/tools/scripts/container-watch-cron.sh

set -uo pipefail

DOMAINS_ROOT="${DOMAINS_ROOT:-$HOME/projects/domains}"
TOOL="$DOMAINS_ROOT/tools/container-watch/check_containers.py"
STATE="$DOMAINS_ROOT/tools/container-watch/state/last.json"
LOG="${CONTAINER_WATCH_LOG:-$DOMAINS_ROOT/tools/container-watch/state/cron.log}"
LOCK="/tmp/container-watch.lock"
CHANNEL="${SLACK_CHANNEL_FLEET:-#fleet-ops}"
LOG_MAX_BYTES=$((2 * 1024 * 1024))

mkdir -p "$(dirname "$STATE")"
exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

redact() {
  sed -E -e 's#(https?://)[^/@[:space:]]+@#\1***@#g' \
         -e 's#(xox[baprs]-)[A-Za-z0-9-]+#\1***#g' \
         -e 's#(gh[pousr]_)[A-Za-z0-9]+#\1***#g'
}

NOTIFY() {
  local text color
  text="$(printf '%s' "$1" | redact)"
  color="${2:-warning}"
  [[ -z "${SLACK_BOT_TOKEN:-}" ]] && return 0
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({'channel': sys.argv[1], 'attachments': [{'color': sys.argv[3], 'text': sys.argv[2], 'mrkdwn_in': ['text']}]}))
" "$CHANNEL" "$text" "$color" 2>/dev/null) || return 0
  curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" https://slack.com/api/chat.postMessage >/dev/null 2>&1 || true
}

[[ -f "$TOOL" ]] || { log "tool missing at $TOOL"; exit 0; }

OUT="$(python3 "$TOOL" --json 2>/dev/null)"
rc=$?

# rc 2 = the watchdog could not see docker at all. Silence would be
# indistinguishable from "all clear", so this one always speaks.
if [[ "$rc" == "2" ]]; then
  log "SCAN FAILED (rc=2)"
  NOTIFY ":rotating_light: container-watch could not query docker — the host-wide watchdog is BLIND. See \`$LOG\`." "danger"
  exit 0
fi

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
printf '%s' "$OUT" > "$TMP"

MSG="$(STATE="$STATE" python3 - "$TMP" <<'PY'
import json, os, sys
try:
    cur = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("PARSE_FAIL"); sys.exit(0)

state_path = os.environ["STATE"]
try:
    prev = json.load(open(state_path, encoding="utf-8"))
except Exception:
    prev = {"findings": []}

key = lambda f: f"{f['kind']}:{f['name']}"
now_keys = {key(f) for f in cur.get("findings", [])}
old_keys = {key(f) for f in prev.get("findings", [])}

new = [f for f in cur.get("findings", []) if key(f) not in old_keys]
gone = sorted(old_keys - now_keys)

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(cur, fh, indent=2)

print(f"SUMMARY scanned={cur.get('scanned')} findings={len(cur.get('findings', []))} new={len(new)} resolved={len(gone)}")
lines = []
for f in new:
    proj = f.get("project") or "no compose project"
    lines.append(f"• *{f['name']}* [{proj}] — {f['kind']}: {f['detail']}")
if lines:
    print("---ALERT---")
    print(":package: container-watch — new finding(s):")
    print("\n".join(lines[:15]))
    print("\nSilence a deliberate one in `tools/container-watch/config.json`.")
PY
)"

if [[ "$MSG" == PARSE_FAIL* ]]; then
  log "unparseable output"
  NOTIFY ":warning: container-watch produced unparseable output. See \`$LOG\`." "danger"
  exit 0
fi

log "${MSG%%---ALERT---*}"
alert="${MSG#*---ALERT---}"
[[ "$alert" != "$MSG" ]] && NOTIFY "$alert" "warning"
exit 0
