#!/usr/bin/env bash
# Hourly fleet git-hygiene sweep.
#
# Classifies every dirty path in the monorepo + all sites/* submodules against
# tools/fleet-git/policy.json, then commits / ignores / pushes what policy
# recognises and queues the rest for one operator decision on the Fleet
# Dashboard's Git Hygiene tab.
#
# Healthy = SILENT on Slack (same convention as fleet-images-drift-cron.sh).
# It speaks up only for: a blocked credential-shaped path, a git error, or a
# review item that has been sitting unresolved for more than REVIEW_NAG_HOURS.
#
# Install (host crontab):
#   17 * * * * /home/jesse/projects/domains/tools/scripts/fleet-git-hygiene-cron.sh

set -uo pipefail

DOMAINS_ROOT="${DOMAINS_ROOT:-$HOME/projects/domains}"
FG="$DOMAINS_ROOT/tools/fleet-git/bin/fleet-git.js"
LOG="${FLEET_GIT_LOG:-$DOMAINS_ROOT/tools/fleet-git/state/cron.log}"
LOCK="/tmp/fleet-git-hygiene.lock"
LOG_MAX_BYTES=$((2 * 1024 * 1024))
CHANNEL="${SLACK_CHANNEL_FLEET:-#fleet-ops}"
REVIEW_NAG_HOURS="${REVIEW_NAG_HOURS:-24}"

mkdir -p "$(dirname "$LOG")"
exec 9>"$LOCK"
# A sweep pushes ~49 repos; overlapping runs would interleave commits.
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

NOTIFY() {
  local text="$1" color="${2:-warning}"
  [[ -z "${SLACK_BOT_TOKEN:-}" ]] && return 0
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({'channel': sys.argv[1], 'attachments': [{'color': sys.argv[3], 'text': sys.argv[2], 'mrkdwn_in': ['text']}]}))
" "$CHANNEL" "$text" "$color" 2>/dev/null) || return 0
  curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" https://slack.com/api/chat.postMessage >/dev/null 2>&1 || true
}

[[ -f "$FG" ]] || { log "fleet-git not found at $FG"; exit 0; }

# Transport: every site repo's remote is the ssh-config alias
# `git@github-bourneash:...`. Inside a container that alias is not resolvable
# (no ~/.ssh/config on the container HOME), so the push fails with
# "Could not resolve hostname github-bourneash". Pin the identity and map the
# alias to the real host explicitly — same form the fleet-dashboard container
# uses. Not overridden if the caller already set one.
if [[ -z "${GIT_SSH_COMMAND:-}" && -f "$HOME/.ssh/github-bourneash" ]]; then
  export GIT_SSH_COMMAND="ssh -F /dev/null -i $HOME/.ssh/github-bourneash -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o HostName=github.com"
fi

# Identity fallback for a repo that has no user.name/user.email of its own.
# fleet-git applies this via `-c` ONLY when git cannot resolve an identity, so
# each site's own bot author is preserved.
export FLEET_GIT_IDENTITY_NAME="${FLEET_GIT_IDENTITY_NAME:-Fleet Git Hygiene}"
export FLEET_GIT_IDENTITY_EMAIL="${FLEET_GIT_IDENTITY_EMAIL:-ops@fleet.local}"

# stderr must NOT be folded into stdout: the report is parsed as JSON, and one
# stray warning line would make the whole sweep look like a failure.
ERR_TMP="$(mktemp)"
out="$(node "$FG" sweep --apply --json 2>"$ERR_TMP")"
rc=$?
if [[ -s "$ERR_TMP" ]]; then
  log "stderr: $(tr '\n' ' ' < "$ERR_TMP" | cut -c1-800)"
fi
rm -f "$ERR_TMP"

# Parse the report with python (jq is not guaranteed on every host here).
REPORT_TMP="$(mktemp)"; trap 'rm -f "$REPORT_TMP"' EXIT
printf '%s' "$out" > "$REPORT_TMP"
summary="$(REVIEW_NAG_HOURS="$REVIEW_NAG_HOURS" python3 - "$REPORT_TMP" <<'PY' 
import json, os, sys, datetime
raw = open(sys.argv[1], encoding='utf-8').read()
try:
    rep = json.loads(raw)
except Exception:
    print("PARSE_FAIL")
    print(raw[:1500])
    sys.exit(0)

nag_h = float(os.environ.get("REVIEW_NAG_HOURS", "24"))
now = datetime.datetime.now(datetime.timezone.utc)
stale = []
for i in rep.get("queue", []):
    fs = i.get("first_seen")
    if not fs:
        continue
    try:
        t = datetime.datetime.fromisoformat(fs.replace("Z", "+00:00"))
    except Exception:
        continue
    if (now - t).total_seconds() / 3600 >= nag_h:
        stale.append(f"{i['slug']}: {i['path']}")

lines = []
lines.append(f"OK repos={rep.get('repos')} dirty={len(rep.get('dirty', []))} review={rep.get('reviewCount')}")
alerts = []
for b in rep.get("blocked", []):
    alerts.append(f":no_entry: *{b['slug']}* — credential-shaped path `{b['path']}` in the tree; repo halted.")
for e in rep.get("errors", []):
    alerts.append(f":warning: git error — {e}")
if stale:
    alerts.append(
        f":clipboard: {len(stale)} git-hygiene review item(s) unresolved >{int(nag_h)}h:\n" +
        "\n".join(f"• `{s}`" for s in stale[:15]) +
        "\n<http://localhost:4754/#githygiene|Git Hygiene board>"
    )
print("\n".join(lines))
print("---ALERTS---")
print("\n\n".join(alerts))
PY
)"

body="${summary%%---ALERTS---*}"
alerts="${summary#*---ALERTS---}"
log "rc=$rc ${body//$'\n'/ }"

if [[ "$body" == PARSE_FAIL* ]]; then
  log "unparseable report: $out"
  NOTIFY ":warning: fleet-git sweep produced an unparseable report (rc=$rc). See \`$LOG\`." "danger"
  exit 0
fi

alerts="$(printf '%s' "$alerts" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -n "$alerts" ]]; then
  NOTIFY "$alerts" "warning"
fi
exit 0
