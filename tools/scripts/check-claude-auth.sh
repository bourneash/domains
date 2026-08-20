#!/usr/bin/env bash
# Fleet-wide Claude Code auth health check.
#
# Every site's cron/worker containers bind-mount the SAME host OAuth session
# (~/.claude/.credentials.json) read-write. When that session expires, EVERY
# AI-driven cron role across the whole fleet fails simultaneously — but each
# site's own watchdog is blind to this: it only detects live-site/build/deploy
# symptoms, and its own auto-repair pass tries to fix things via more `claude`
# calls, which fail on the exact same dead session. The result (observed
# 2026-08-02 through 2026-08-08): a week of silent, fleet-wide content outage
# with no alert anyone actually saw, because 20 separate watchdogs each spent
# days grinding through their own 3-attempt cooldown cycles before escalating.
#
# This is the single, cheap, host-level check that should have caught it in
# minutes: one `claude -p` call against the SAME shared credential the whole
# fleet uses, run directly on the host (not through any per-site container),
# every 15 min via host crontab. On sustained failure it posts one loud,
# immediate alert to the fleet-wide #domain-ops channel — not 20 separate
# per-site channels — because this is fleet infra, not a per-site symptom.
#
# Same host-cron, fleet-loop, rate-limited-alert pattern as
# tools/scripts/ensure-fleet-cron.sh — read that header too if this is new to
# you.
#
# Requires 2 CONSECUTIVE failing ticks (~15-30min) before alerting, to avoid
# paging on a single transient blip (network hiccup, momentary rate limit).
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
LOG="${AUTH_CHECK_LOG:-$DOMAINS_ROOT/tools/scripts/check-claude-auth.log}"
LOCK="${AUTH_CHECK_LOCK:-$DOMAINS_ROOT/tools/scripts/check-claude-auth.lock}"
STATE="${AUTH_CHECK_STATE:-$DOMAINS_ROOT/tools/scripts/.check-claude-auth-state}"
TIMEOUT_SEC="${AUTH_CHECK_TIMEOUT:-30}"
# Cron's PATH is minimal and does NOT include ~/.local/bin (where the CLI
# actually lives) — resolve explicitly rather than relying on `claude` being
# found bare, which fails with exit 127 "no such file" and would otherwise
# get misread as an auth failure. Learned this the hard way on first deploy:
# the very first real cron tick fired a false-positive fleet-down alert.
CLAUDE_BIN="${AUTH_CHECK_CLAUDE_BIN:-}"
if [[ -z "$CLAUDE_BIN" ]]; then
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_BIN="$(command -v claude)"
  elif [[ -x "$HOME/.local/bin/claude" ]]; then
    CLAUDE_BIN="$HOME/.local/bin/claude"
  else
    CLAUDE_BIN="claude"  # let it fail loudly and visibly in the log below
  fi
fi
FAIL_THRESHOLD="${AUTH_CHECK_FAIL_THRESHOLD:-2}"   # consecutive failing ticks before alerting
CHANNEL="${AUTH_CHECK_CHANNEL:-domain-ops}"
LOG_MAX_BYTES="${AUTH_CHECK_LOG_MAX_BYTES:-2097152}"
ALERT_COOLDOWN="${AUTH_CHECK_ALERT_COOLDOWN:-3600}"  # re-alert at most hourly while still down
ALERT_MARKER="${AUTH_CHECK_ALERT_MARKER:-$DOMAINS_ROOT/tools/scripts/.check-claude-auth-alerted}"

mkdir -p "$(dirname "$LOG")"

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  log_size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$log_size" =~ ^[0-9]+$ ]] && (( log_size > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }
NOTIFY() {
  local text="$1" color="$2"
  [[ -z "${SLACK_BOT_TOKEN:-}" ]] && return 0
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({'channel': sys.argv[1], 'attachments': [{'color': sys.argv[3], 'text': sys.argv[2], 'mrkdwn_in': ['text']}]}))
" "$CHANNEL" "$text" "$color" 2>/dev/null) || return 0
  curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" https://slack.com/api/chat.postMessage >/dev/null 2>&1 || true
}

# Known auth-failure signatures — same strings that fired all week across
# every site's cron logs during the 2026-08 outage. Kept as a list (not a
# single grep -E) so a new signature is a one-line addition, easy to diff.
AUTH_FAIL_PATTERNS=(
  'Not logged in'
  'Please run /login'
  'OAuth session expired'
  'could not be refreshed'
  'authentication_error'
  'invalid.*api.?key'
)

matches_auth_failure() {
  local text="$1" pat
  for pat in "${AUTH_FAIL_PATTERNS[@]}"; do
    grep -qiE "$pat" <<<"$text" && return 0
  done
  return 1
}

OUTPUT="$(timeout "$TIMEOUT_SEC" "$CLAUDE_BIN" -p "Reply with exactly one word: OK" --model claude-haiku-4-5-20251001 --dangerously-skip-permissions 2>&1)"
EXIT_CODE=$?

read -r PREV_COUNT < "$STATE" 2>/dev/null || PREV_COUNT=0
[[ "$PREV_COUNT" =~ ^[0-9]+$ ]] || PREV_COUNT=0

if [[ "$EXIT_CODE" -eq 0 ]] && grep -qi '\bOK\b' <<<"$OUTPUT"; then
  log "healthy — claude -p responded OK"
  if [[ -f "$ALERT_MARKER" ]]; then
    NOTIFY ":white_check_mark: *Fleet Claude Code auth recovered* — the shared OAuth session (~/.claude/.credentials.json) is working again. Every site's cron roles should resume on their normal schedule." "good"
    log "posted recovery notice (had been down for $PREV_COUNT consecutive tick(s))"
    rm -f "$ALERT_MARKER"
  fi
  echo 0 > "$STATE"
  exit 0
fi

NEW_COUNT=$(( PREV_COUNT + 1 ))
echo "$NEW_COUNT" > "$STATE"
log "FAIL (tick $NEW_COUNT, exit=$EXIT_CODE): $(head -c 300 <<<"$OUTPUT")"

if [[ "$NEW_COUNT" -lt "$FAIL_THRESHOLD" ]]; then
  log "below alert threshold ($NEW_COUNT/$FAIL_THRESHOLD) — waiting for next tick to confirm"
  exit 0
fi

# Confirmed down (>= FAIL_THRESHOLD consecutive ticks). Alert now, then at most
# once per ALERT_COOLDOWN thereafter until it recovers (marker cleared above).
now="$(date +%s)"; last_alert=0
[[ -f "$ALERT_MARKER" ]] && last_alert="$(stat -c %Y "$ALERT_MARKER" 2>/dev/null || echo 0)"
if (( now - last_alert >= ALERT_COOLDOWN )); then
  IS_AUTH="not-classified"
  matches_auth_failure "$OUTPUT" && IS_AUTH="confirmed"
  NOTIFY ":rotating_light: <!here> *Fleet-wide Claude Code auth is DOWN* — \`claude -p\` has failed ${NEW_COUNT} consecutive checks (~$(( NEW_COUNT * 15 ))min so far).
Every site's cron/worker containers share this same host OAuth session — this means EVERY AI-driven cron role fleet-wide (content-writer, engineer, affiliate-editor, seo-analyst, watchdog auto-repair, ...) is silently failing right now, not just one site.
Signature match: ${IS_AUTH}
Output: \`$(head -c 200 <<<"$OUTPUT" | tr '\n' ' ')\`

*Fix:* refresh the host session — run \`claude /login\` as the \`jesse\` user. The fleet has no \`ANTHROPIC_API_KEY\` fallback by design (only one auth path to keep straight). This will re-alert hourly (\`AUTH_CHECK_ALERT_COOLDOWN\`) while still down and post a recovery notice once fixed." "danger"
  log "ALERTED — posted to #$CHANNEL"
  touch "$ALERT_MARKER"
else
  log "still down (tick $NEW_COUNT) — within alert cooldown, not re-posting yet"
fi
exit 1
