#!/usr/bin/env bash
# domain-developer worker Claude-auth guard.
#
# dd-<site> worker containers have independent Claude OAuth sessions. The host
# credential is deliberately never mounted into a worker: copying a rotating
# refresh token into multiple writable workers can revoke the whole family.
#
# 2026-08-23 incident (root-caused): OAuth refresh tokens are single-use/
# rotating. Whichever of {host, dd-shoptopless.com, dd-americastrikes.com, ...}
# redeems FIRST rotates the shared family; the next one to redeem is using an
# already-superseded token, which reuse-detection treats as compromise and
# revokes the WHOLE family — killing the legitimate host session too, not
# just the stale copy. This is why the host's real interactive session
# started getting logged out every couple of days once enough independent
# redeemers (dd-workers here, job 4's checks) existed: it's a race between
# every writable copy of one shared credential, not an Anthropic-side bug.
#
# Fix: workers establish their own session with `claude /login`; this guard
# verifies that the host credential is not accidentally mounted back in. It
# does not probe Claude, because a probe mutates state and cannot distinguish
# auth validity from a transient network/model failure.
#
# Workers are cattle (no restart policy, destroyed rather than resurrected,
# idle-reaped within 4h). This job only verifies the no-host-credential
# invariant; it never restarts or rewrites a worker.
#
# Companion to check-claude-auth.sh (which only checks the HOST session).
# Same host-cron, fleet-loop, rate-limited-alert conventions — read that
# script's header first if this is new to you.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
LOG="${DD_AUTH_CHECK_LOG:-$DOMAINS_ROOT/tools/scripts/check-dd-containers-auth.log}"
LOCK="${DD_AUTH_CHECK_LOCK:-$DOMAINS_ROOT/tools/scripts/check-dd-containers-auth.lock}"
TIMEOUT_SEC="${DD_AUTH_CHECK_TIMEOUT:-30}"
CHANNEL="${DD_AUTH_CHECK_CHANNEL:-domain-ops}"
LOG_MAX_BYTES="${DD_AUTH_CHECK_LOG_MAX_BYTES:-2097152}"
ALERT_COOLDOWN="${DD_AUTH_ALERT_COOLDOWN:-3600}"
ALERT_DIR="${DD_AUTH_ALERT_DIR:-$DOMAINS_ROOT/tools/scripts/.dd-auth-alerts}"
LIFECYCLE_LOCK="${DD_LIFECYCLE_LOCK:-$DOMAINS_ROOT/tools/domain-developer/state/.lifecycle.lock}"

# Host credential path used only to detect an accidental worker mount.
HOST_CRED_FILE="${DD_AUTH_HOST_CRED:-$HOME/.claude/.credentials.json}"

exec 9>"$LOCK"
flock -n 9 || exit 0
mkdir -p "$(dirname "$LIFECYCLE_LOCK")"
exec 8>"$LIFECYCLE_LOCK"
flock -w "${DD_LIFECYCLE_LOCK_WAIT:-30}" -x 8 || exit 0

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
  local response
  response="$(curl -sS --max-time 15 -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" https://slack.com/api/chat.postMessage 2>/dev/null)" || { log "warning: Slack notification request failed"; return 0; }
  python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("ok") else 1)' <<<"$response" \
    || log "warning: Slack notification rejected"
}

# Verify the worker is not receiving the host OAuth credential. A worker with
# no credentials is expected until its operator runs `claude /login`; that is
# not an infrastructure failure. A host credential mount is a security and
# token-family violation and is actionable.
worker_auth_isolated() {
  local container="$1" mounts
  mounts="$(timeout "$TIMEOUT_SEC" docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$container" 2>/dev/null || true)"
  ! grep -Fqw -- "$HOST_CRED_FILE" <<<"$mounts"
}

worker_has_auth() {
  local container="$1"
  timeout "$TIMEOUT_SEC" docker exec "$container" test -s /home/dev/.claude/.credentials.json 2>/dev/null
}

# Auto-discover worker containers (excludes dd-panel, which mounts the full
# ~/.claude dir RO and isn't subject to this bug). Sorted for a stable,
# deterministic stagger index run over run.
mapfile -t WORKERS < <(docker ps --filter "name=^dd-" --format '{{.Names}}' | grep -v '^dd-panel$' | sort)

if [[ "${#WORKERS[@]}" -eq 0 ]]; then
  log "no dd-* worker containers running — nothing to check"
  exit 0
fi

mkdir -p "$ALERT_DIR"
for site in "${WORKERS[@]}"; do
  alert_file="$ALERT_DIR/$site"
  if ! worker_auth_isolated "$site"; then
    log "$site: SECURITY FAILURE — host OAuth credential is mounted in the worker"
    now="$(date +%s)"; last=0
    [[ -f "$alert_file" ]] && last="$(stat -c %Y "$alert_file" 2>/dev/null || echo 0)"
    if (( now - last >= ALERT_COOLDOWN )); then
      NOTIFY ":rotating_light: *domain-developer worker \`$site\`* still has the host Claude OAuth credential mounted. Recreate it to migrate to an independent worker session: \`tools/domain-developer/bin/dd-recreate ${site#dd-}\`." "danger"
      touch "$alert_file"
    fi
    continue
  fi

  if worker_has_auth "$site"; then
    log "$site: isolated Claude credential present"
    if [[ -f "$alert_file" ]]; then
      NOTIFY ":white_check_mark: *domain-developer worker \`$site\`* no longer has the host OAuth credential mounted." "good"
      rm -f "$alert_file"
    fi
  else
    log "$site: isolated Claude credential not present — awaiting `claude /login`"
  fi
done

exit 0
