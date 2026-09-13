#!/usr/bin/env bash
# Post a message to a Slack channel via the Domain Ops bot token.
#
# CANONICAL fleet-wide copy. Every site's `ops/scripts/notify-slack.sh` is a
# thin delegator to this file (see the shim's own header) — this is the one
# place to fix or extend the behavior. Assembled 2026-09-13 from the two
# variants that had drifted ahead of the rest of the fleet: reviewtattoo.com's
# quiet-gate severity_override fix, and sinderella.org's thread_ts / real
# API-response handling (both live, load-bearing features — verify a change
# here against both use cases before rolling it out).
#
# Usage: notify-slack.sh <channel> <text> [color] [thread_ts]
#   channel   — Slack channel name (no #) or channel ID
#   text      — Message body; Slack mrkdwn supported; literal newlines OK
#   color     — Attachment sidebar: good | warning | danger | #rrggbb
#               Default: #2eb67d (green)
#   thread_ts — Optional: post as a reply inside this thread (parent message ts)
#
# On a successful post, prints the message `ts` to stdout so the caller can
# thread follow-up replies under it (capture with $(...)). Diagnostics go to
# stderr only, so the captured stdout is always just the bare ts (or empty).
#
# Env overrides:
#   SLACK_VERBOSE          — 1/true/yes/on: bypass the quiet gate below for
#                             this call (also settable per-invocation).
#   SLACK_SEVERITY_OVERRIDE — force a specific severity instead of deriving it
#                             from color. NOT a positional arg (thread_ts
#                             already owns position 4) — set it as an env var
#                             on the call, e.g.:
#                               SLACK_SEVERITY_OVERRIDE=resolved "$NOTIFY" ...
#                             Any value other than "info" bypasses the quiet
#                             gate regardless of color, and the value is what
#                             lands in the disk log's "severity" field. Use
#                             this for a "good"-colored message that must
#                             still be delivered — e.g. confirming an earlier
#                             alert is resolved, or a role's dispatch ack for
#                             an alert Jesse already saw. Without this, EVERY
#                             "good"-colored message is silently dropped by
#                             the quiet gate unless SLACK_VERBOSE is set —
#                             confirmed fleet-wide gap: reviewtattoo.com's
#                             principal-engineer resolved/resolved-noise/ack
#                             posts had a 100% silent-failure rate from
#                             2026-09-07 (when the quiet gate was introduced)
#                             until this override was added.
#
# Reads SLACK_BOT_TOKEN from environment (set in /home/jesse/projects/domains/.env).
# Silent no-op if SLACK_BOT_TOKEN is unset — never exits non-zero.
#
# Disk logging: every call that reaches this point (even with no Slack token
# configured) also appends one JSON line to ops/logs/slack-<UTC-date>.jsonl
# UNDER THE CALLING SITE'S OWN ops/ directory, not wherever this canonical
# file happens to live. Since every site invokes this via `exec` from its own
# ops/scripts/notify-slack.sh shim, ${BASH_SOURCE[0]} in THIS process is this
# canonical file's own path (tools/scripts/notify-slack.sh) — deriving
# repo_root from it would resolve to the fleet's tools/ parent, not the site.
# The shim exports NOTIFY_LOG_ROOT (its own site root) before exec'ing this
# file; log_to_disk below must use that, falling back to BASH_SOURCE only for
# a direct/standalone invocation of this file itself. This is the fleet's
# only durable record of what got posted — the Slack API call itself is
# fire-and-forget and a dropped/rate-limited post previously left no trace
# anywhere. The principal-engineer role reads this log to find real
# errors/warnings without re-deriving them from role scripts. Logging is
# best-effort and must never affect this script's own behavior or exit code.
set -uo pipefail

CHANNEL="${1:-}"
TEXT="${2:-}"
COLOR="${3:-#2eb67d}"
THREAD_TS="${4:-}"
SEVERITY_OVERRIDE="${SLACK_SEVERITY_OVERRIDE:-}"

if [[ -z "$CHANNEL" || -z "$TEXT" ]]; then
  echo "[notify-slack] usage: $0 <channel> <text> [color] [thread_ts]" >&2
  exit 0
fi

# Severity from the attachment color. Named tokens are what every caller in
# this fleet actually uses (good/warning/danger); a raw #rrggbb is treated as
# "info" since nothing here passes a custom hex for an error today.
case "$COLOR" in
  danger)  SEVERITY="error" ;;
  warning) SEVERITY="warning" ;;
  *)       SEVERITY="info" ;;
esac
[[ -n "$SEVERITY_OVERRIDE" ]] && SEVERITY="$SEVERITY_OVERRIDE"

# Quiet by default: generic successful role/setup messages are intermediate
# chatter. Dedicated article/social publishers send the final result directly.
# Warnings and errors deliberately bypass this gate, as does SEVERITY_OVERRIDE
# above (anything other than "info").
case "${SLACK_VERBOSE:-}" in
  1|true|TRUE|yes|YES|on|ON) ;;
  *) [[ "$SEVERITY" == "info" ]] && exit 0 ;;
esac

log_to_disk() {
  local repo_root log_dir log_file
  repo_root="${NOTIFY_LOG_ROOT:-}"
  [[ -d "$repo_root" ]] || repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || return 0
  log_dir="$repo_root/ops/logs"
  mkdir -p "$log_dir" 2>/dev/null || return 0
  log_file="$log_dir/slack-$(date -u +%Y-%m-%d).jsonl"
  python3 -c "
import json, sys, time
ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
print(json.dumps({'ts': ts, 'channel': sys.argv[1], 'color': sys.argv[2], 'severity': sys.argv[3], 'text': sys.argv[4]}))
" "$CHANNEL" "$COLOR" "$SEVERITY" "$TEXT" >> "$log_file" 2>/dev/null || true
}
log_to_disk

[[ -z "${SLACK_BOT_TOKEN:-}" ]] && exit 0

# Python builds the JSON payload so arbitrary text (quotes, newlines, etc.) is
# encoded correctly without fragile shell escaping.
PAYLOAD=$(python3 -c "
import json, sys
channel, text, color, thread_ts = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
msg = {
    'channel': channel,
    'attachments': [{
        'color': color,
        'text': text,
        'mrkdwn_in': ['text']
    }]
}
if thread_ts:
    msg['thread_ts'] = thread_ts
print(json.dumps(msg))
" "$CHANNEL" "$TEXT" "$COLOR" "$THREAD_TS" 2>/dev/null) || {
  echo "[notify-slack] could not build JSON payload — skipping" >&2
  exit 0
}

# Capture the response body (drop -f: a non-2xx still returns a JSON body we
# want to inspect) so we can surface a real API error and return the posted
# message ts on success (for threading).
RESP=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 10 \
  2>/dev/null) || {
  echo "[notify-slack] warning: Slack API unreachable (notification dropped)" >&2
  exit 0
}

# Print the ts on stdout (for thread chaining); surface API errors on stderr.
python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
if d.get('ok'):
    print(d.get('ts', ''))
else:
    sys.stderr.write('[notify-slack] Slack API error: %s\n' % d.get('error', 'unknown'))
" "$RESP" 2>/dev/null || true

exit 0
