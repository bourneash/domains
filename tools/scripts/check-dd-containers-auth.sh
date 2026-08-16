#!/usr/bin/env bash
# domain-developer worker Claude-auth guard.
#
# dd-<site> worker containers (tools/domain-developer) copy the host's OAuth
# credential into a writable path ONCE at container start (RO-staged file ->
# writable copy — see bin/domain-developer's comment on why it can't just RO-
# bind the destination: that broke Claude's own in-place refresh writes).
# That copy can never self-heal after boot: the host rotates the token via
# atomic rename roughly every 8h, and even if it didn't, OAuth refresh tokens
# are typically single-use/rotating, so a copy that outlives one host-side
# rotation is holding a refresh token that's already been consumed elsewhere.
# These workers are meant to be spun up "on demand" (README.md) but
# `--restart unless-stopped` with no idle-timeout means once started they run
# indefinitely — 2026-08-16 incident: dd-shoptopless.com/dd-americastrikes.com
# sat idle 8 days since their last boot and both went to "Not logged in".
#
# This job (a) self-heals on confirmed failure — a plain restart re-runs the
# entrypoint's copy step against the CURRENT host credential, which is all
# that's needed, since state lives on host binds (not volumes) per
# tools/domain-developer/REDESIGN.md and survives a restart intact — and
# (b) proactively restarts on a long interval even when healthy, so a worker
# that just sits idle can't silently drift past the host's rotation window
# again. Proactive restarts are staggered per-site so a fleet of workers
# doesn't all bounce in the same tick.
#
# Companion to check-claude-auth.sh (which only checks the HOST session).
# Same host-cron, fleet-loop, rate-limited-alert conventions — read that
# script's header first if this is new to you.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
LOG="${DD_AUTH_CHECK_LOG:-$DOMAINS_ROOT/tools/scripts/check-dd-containers-auth.log}"
LOCK="${DD_AUTH_CHECK_LOCK:-$DOMAINS_ROOT/tools/scripts/check-dd-containers-auth.lock}"
STATE_DIR="${DD_AUTH_CHECK_STATE_DIR:-$DOMAINS_ROOT/tools/scripts/.dd-auth-state}"
TIMEOUT_SEC="${DD_AUTH_CHECK_TIMEOUT:-30}"
CHANNEL="${DD_AUTH_CHECK_CHANNEL:-domain-ops}"
LOG_MAX_BYTES="${DD_AUTH_CHECK_LOG_MAX_BYTES:-2097152}"
# Proactive restart cadence — comfortably under the host's ~8h token-rotation
# window so a worker can never coast past a rotation unnoticed, without
# restarting so often it's needless churn (each restart kills any live tmux
# client attach — server persists per REDESIGN.md, but the browser tab drops).
PROACTIVE_INTERVAL_SEC="${DD_AUTH_PROACTIVE_INTERVAL:-43200}"   # 12h
STAGGER_STEP_SEC="${DD_AUTH_STAGGER_STEP:-1800}"                # 30min apart per site, by discovery order

mkdir -p "$STATE_DIR"
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

probe_ok() {
  local container="$1" output exit_code
  output="$(timeout "$TIMEOUT_SEC" docker exec "$container" claude -p "Reply with exactly one word: OK" --dangerously-skip-permissions 2>&1)"
  exit_code=$?
  [[ "$exit_code" -eq 0 ]] && grep -qi '\bOK\b' <<<"$output"
}

# Auto-discover worker containers (excludes dd-panel, which mounts the full
# ~/.claude dir RO and isn't subject to this bug). Sorted for a stable,
# deterministic stagger index run over run.
mapfile -t WORKERS < <(docker ps --filter "name=^dd-" --format '{{.Names}}' | grep -v '^dd-panel$' | sort)

if [[ "${#WORKERS[@]}" -eq 0 ]]; then
  log "no dd-* worker containers running — nothing to check"
  exit 0
fi

idx=0
for site in "${WORKERS[@]}"; do
  state_file="$STATE_DIR/${site}.last-restart"
  stagger_offset=$(( idx * STAGGER_STEP_SEC ))
  idx=$(( idx + 1 ))

  if probe_ok "$site"; then
    last_restart=0
    [[ -f "$state_file" ]] && last_restart="$(cat "$state_file" 2>/dev/null || echo 0)"
    [[ "$last_restart" =~ ^[0-9]+$ ]] || last_restart=0
    now="$(date +%s)"
    due_at=$(( last_restart + PROACTIVE_INTERVAL_SEC + stagger_offset ))
    if (( last_restart == 0 )); then
      # First time we've seen this container — seed the clock, don't restart
      # a container that's already healthy just because we have no history.
      echo "$now" > "$state_file"
      log "$site: healthy, seeding proactive-restart clock (next due ~$(( PROACTIVE_INTERVAL_SEC / 3600 ))h + ${stagger_offset}s stagger from now)"
    elif (( now >= due_at )); then
      log "$site: healthy but proactive interval elapsed (last restart $(( (now - last_restart) / 3600 ))h ago) — restarting preemptively to avoid drifting past the host's token-rotation window"
      docker restart "$site" >/dev/null 2>&1
      echo "$now" > "$state_file"
      log "$site: proactive restart complete"
    else
      log "$site: healthy"
    fi
    continue
  fi

  # Confirmed failure — self-heal: restart re-runs the entrypoint's copy of
  # the current host credential, which is all a stale in-container copy ever
  # needed. State lives on host binds, not the container, so this is safe.
  log "$site: FAILED probe — attempting self-heal restart"
  docker restart "$site" >/dev/null 2>&1
  sleep 5
  now="$(date +%s)"
  echo "$now" > "$state_file"

  if probe_ok "$site"; then
    log "$site: self-heal succeeded — restart cleared it"
    NOTIFY ":arrows_counterclockwise: *domain-developer worker \`$site\`* had a stale Claude auth copy — restarted automatically and confirmed healthy. No action needed." "warning"
  else
    log "$site: self-heal FAILED — still broken after restart, needs a human"
    NOTIFY ":rotating_light: *domain-developer worker \`$site\`* has broken Claude auth and did NOT recover after an automatic restart. This is not the shared host session (see check-claude-auth.sh) — check the host's live session is healthy first, then \`docker logs $site\` / \`docker exec $site claude /login\`." "danger"
  fi
done

exit 0
