#!/usr/bin/env bash
# Fleet social-controller cron entrypoint. The ordering here is load-bearing:
# the queue preflight happens before any Claude setup/invocation, so an empty
# queue costs zero model tokens and exits in milliseconds.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="${SOCIAL_CONTROLLER_TOOL_DIR:-$DOMAINS_ROOT/tools/social-controller}"
DATA_DIR="${SOCIAL_CONTROLLER_DATA_DIR:-$TOOL_DIR/data}"
LOG="${SOCIAL_CONTROLLER_LOG:-$DATA_DIR/controller.log}"
LOCK="${SOCIAL_CONTROLLER_LOCK:-$DATA_DIR/controller.lock}"
LIMIT="${SOCIAL_CONTROLLER_LIMIT:-60}"
MAX_TURNS="${SOCIAL_CONTROLLER_MAX_TURNS:-45}"
TIMEOUT="${SOCIAL_CONTROLLER_TIMEOUT:-2400}"
TRACKED="${SOCIAL_CONTROLLER_CLAUDE_TRACKED:-$DOMAINS_ROOT/tools/scripts/claude-tracked.sh}"

[[ -f "$TOOL_DIR/.controller-disabled" ]] && exit 0
mkdir -p "$DATA_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > 5242880 )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

PACKET="$(mktemp "$DATA_DIR/review-packet.XXXXXX")" || exit 1
trap 'rm -f "$PACKET"' EXIT

# ZERO-AI PRECHECK. Do not move environment/model setup above this block.
COUNT="$(python3 "$TOOL_DIR/controller.py" prepare --output "$PACKET" --limit "$LIMIT" 2>>"$LOG")"
if [[ ! "$COUNT" =~ ^[0-9]+$ ]]; then
  log "preflight failed: invalid count '$COUNT'"
  exit 1
fi
if (( COUNT == 0 )); then
  exit 0
fi

log "review start: $COUNT public draft(s)"
[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

# fleet-cron's host Claude mount is intentionally read-only; this helper gives
# tool-using sessions a writable config dir while retaining live credentials.
source "$DOMAINS_ROOT/tools/scripts/ai-optimizer-claude-env.sh"
export AI_OPT_CLAUDE_HOME="${SOCIAL_CONTROLLER_CLAUDE_HOME:-/tmp/social-controller-claude-home}"
ai_optimizer_claude_env

export CRON_SITE="_fleet"
export CRON_ROLE="social-controller"
export REPO_ROOT="$TOOL_DIR"

PROMPT="$(cat "$TOOL_DIR/role.md")

## This run

The review packet is at $PACKET. Today is $(date -Iseconds). The workspace is
$DOMAINS_ROOT. Review every packet post now and finish by running the packet's
remaining command with this exact packet path."

cd "$DOMAINS_ROOT" || exit 1
timeout "$TIMEOUT" "$TRACKED" "$PROMPT" \
  --max-turns "$MAX_TURNS" \
  --dangerously-skip-permissions \
  --model claude-sonnet-4-6 \
  >> "$LOG" 2>&1
rc=$?

remaining="$(python3 "$TOOL_DIR/controller.py" remaining --packet "$PACKET" 2>>"$LOG")"
remaining_rc=$?
finish="$(python3 "$TOOL_DIR/controller.py" finish --packet "$PACKET" --exit-code "$rc" 2>>"$LOG")"
finish_rc=$?
if (( rc != 0 || remaining_rc != 0 || finish_rc != 0 )); then
  log "review incomplete: claude_exit=$rc remaining=$remaining"
  exit 1
fi

log "review complete: $COUNT decision(s)"
exit 0
