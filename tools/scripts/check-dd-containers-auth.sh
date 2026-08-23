#!/usr/bin/env bash
# domain-developer worker Claude-auth guard.
#
# dd-<site> worker containers (tools/domain-developer) copy the host's OAuth
# credential into a writable path at container start (RO-staged file ->
# writable copy — see bin/domain-developer's comment on why it can't just RO-
# bind the destination: that broke Claude's own in-place refresh writes).
# That copy is a SEPARATE, INDEPENDENTLY-REFRESHING credential once the
# container is up: its own `claude` process will redeem/rotate it against
# Anthropic's OAuth server on its own schedule, with zero coordination with
# the host session or any other dd-* worker holding the same starting token.
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
# Fix: shrink the divergence window to near-zero. Every tick, BEFORE probing,
# we push a fresh copy of the host's CURRENT credential into every worker
# (sync_credentials — a plain file copy, no API call, can't itself trigger a
# redemption). That means a worker's own `claude` can only ever be holding a
# refresh token that's at most one cron tick old, so the odds of it winning a
# race against the host's own redemption collapse from "up to 12h stale" to
# "up to $DD_AUTH_CHECK_TICK stale" (see crontab.docker job 8 — 10min).
#
# 2026-08-23, later the same day: the workers became CATTLE (no restart
# policy, destroyed rather than resurrected on every non-running state, idle-
# reaped within 4h — see tools/scripts/reap-idle-dd-workers.sh's header for
# the three-part fix). That removed the condition this job's heaviest
# machinery existed to work around, so two things changed here:
#
#   * The PROACTIVE restart loop is gone. It existed because a worker could
#     live for days and drift arbitrarily far from the host's credential.
#     A worker's unattended lifetime is now bounded by the idle reaper (4h by
#     default) and its credential is re-synced every tick regardless, so a
#     scheduled bounce bought nothing and cost a killed session every time it
#     fired. Deleting it is the point of doing the cattle work — do not
#     reintroduce it without first showing the reaper has stopped bounding
#     worker lifetime.
#
#   * This job no longer REMEDIATES at all — it syncs and it alerts. It used
#     to `docker restart` a worker on a failed probe. Under cattle the idle
#     reaper (reap-idle-dd-workers.sh) already destroys and rebuilds any
#     unattended worker within 4h, on the current image, with a fresh
#     credential — it is the fleet's universal self-healer, and it is strictly
#     better at it than a restart was (a restart reuses the creation-time
#     image, so it could heal auth while silently preserving stale code).
#     That leaves only workers someone is actively USING, and bouncing one of
#     those on the strength of a check that can fail for benign timing
#     reasons trades a cosmetic fault for real lost work. So this job's
#     remaining job is to keep the credential fresh and be loud when it
#     can't.
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

# Host credential files pushed into every worker every tick — see header.
HOST_CRED_FILE="${DD_AUTH_HOST_CRED:-$HOME/.claude/.credentials.json}"
HOST_SETTINGS_FILE="${DD_AUTH_HOST_SETTINGS:-$HOME/.claude/settings.json}"

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

# Verify the worker is holding the SAME credential bytes the host is, with no
# API call at all.
#
# This replaced an AI probe (`claude -p "Reply with exactly one word: OK"`)
# on 2026-08-23. That probe was wrong on three counts once the workers became
# cattle:
#
#   1. It broke the idle reaper. The probe ran a real Claude session inside
#      the worker, so every tick it wrote a fresh transcript jsonl, security
#      log and .claude.json backup into the worker's HOST-BOUND state dir --
#      the exact directory reap-idle-dd-workers.sh reads mtimes from to decide
#      "is anyone using this?". Every worker therefore looked active-within-
#      10-minutes forever and the 4h idle reaper could never once fire. The
#      cattle model was silently inert until this was removed. (Measured: both
#      live workers reported "active 9min ago" at all times, with timestamps
#      landing exactly on this job's */10 tick.)
#   2. It cost real money for no new information -- ~6 Haiku calls per worker
#      per hour, forever.
#   3. Its failure action (bounce/destroy the worker) could fire against a
#      worker somebody was actively using, on the strength of a probe that can
#      also fail for unrelated reasons (rate limit, network, model outage).
#
# What actually protects against the 2026-08-23 revocation race is the
# credential SYNC, not the probe. And a worker can now only be broken in a way
# the sync doesn't fix if the HOST credential is itself broken -- which is
# exactly what job 4 (check-claude-auth.sh) already watches. So the useful
# assertion left here is narrow and free: after syncing, does the worker's copy
# match the host's? A mismatch means the copy didn't land, which is a real
# fault worth alerting on.
creds_match_host() {
  local container="$1" host_sum cont_sum
  [[ -r "$HOST_CRED_FILE" ]] || return 1
  host_sum="$(sha256sum < "$HOST_CRED_FILE" 2>/dev/null | awk '{print $1}')"
  cont_sum="$(timeout "$TIMEOUT_SEC" docker exec "$container" \
      sha256sum /home/dev/.claude/.credentials.json 2>/dev/null | awk '{print $1}')"
  [[ -n "$host_sum" && "$host_sum" == "$cont_sum" ]]
}

# Push the host's CURRENT credential/settings into a worker's writable copy.
# Plain file copy over `docker exec` — no API call, cannot itself trigger an
# OAuth redemption, so this carries none of the race risk it's defending
# against. Run every tick, unconditionally, for every worker (see header).
sync_credentials() {
  local container="$1" ok=1
  if [[ -r "$HOST_CRED_FILE" ]]; then
    if docker exec -i "$container" sh -c \
        'cat > /home/dev/.claude/.credentials.json.tmp && mv /home/dev/.claude/.credentials.json.tmp /home/dev/.claude/.credentials.json && chmod 600 /home/dev/.claude/.credentials.json' \
        < "$HOST_CRED_FILE" 2>/dev/null; then
      :
    else
      ok=0
    fi
  else
    log "$container: sync skipped — host credential file unreadable ($HOST_CRED_FILE)"
    ok=0
  fi
  if [[ -r "$HOST_SETTINGS_FILE" ]]; then
    docker exec -i "$container" sh -c \
      'cat > /home/dev/.claude/settings.json.tmp && mv /home/dev/.claude/settings.json.tmp /home/dev/.claude/settings.json && chmod 644 /home/dev/.claude/settings.json' \
      < "$HOST_SETTINGS_FILE" 2>/dev/null || true  # best-effort, not auth-critical
  fi
  return $(( 1 - ok ))
}

# Auto-discover worker containers (excludes dd-panel, which mounts the full
# ~/.claude dir RO and isn't subject to this bug). Sorted for a stable,
# deterministic stagger index run over run.
mapfile -t WORKERS < <(docker ps --filter "name=^dd-" --format '{{.Names}}' | grep -v '^dd-panel$' | sort)

if [[ "${#WORKERS[@]}" -eq 0 ]]; then
  log "no dd-* worker containers running — nothing to check"
  exit 0
fi

for site in "${WORKERS[@]}"; do
  if ! sync_credentials "$site"; then
    log "$site: credential sync FAILED (docker exec/copy error)"
    NOTIFY ":warning: *domain-developer worker \`$site\`* — could not push the host's current Claude credential into it (docker exec/copy failed). Its copy will keep drifting until this is fixed; see \`$LOG\`." "warning"
    continue
  fi

  if creds_match_host "$site"; then
    log "$site: credential in sync with host"
    continue
  fi

  # A mismatch immediately after a successful copy is usually BENIGN and
  # self-correcting: `claude` inside the worker rotates .credentials.json in
  # place on OAuth refresh, so a refresh landing between our copy and our
  # checksum reads as a mismatch while nothing is wrong. Re-sync once and
  # re-check before believing it.
  log "$site: credential mismatch right after sync — re-syncing once (a concurrent in-container OAuth refresh looks identical to a real fault)"
  sleep 2
  sync_credentials "$site" || true
  if creds_match_host "$site"; then
    log "$site: credential in sync with host after re-sync (first mismatch was a refresh race)"
    continue
  fi

  # Persistent mismatch. We ALERT ONLY — we do not touch the container.
  #
  # Under the cattle model there is no need for this job to self-heal, and a
  # good reason for it not to: the only remediation available here is
  # destroying the worker, and a worker that is genuinely broken AND idle is
  # already destroyed within DD_IDLE_THRESHOLD_SEC (4h) by
  # reap-idle-dd-workers.sh, on the current image, with a fresh credential —
  # that reaper is the fleet's universal self-healer now. The remaining case
  # is a worker somebody is actively using, and killing that on the strength
  # of a checksum that can disagree for benign timing reasons trades a
  # cosmetic fault for real lost work. So: say so loudly, act never.
  log "$site: credential MISMATCH persists after re-sync — alerting; leaving the container alone (idle reaper will replace it within $(( 14400 / 3600 ))h if nobody is using it)"
  NOTIFY ":warning: *domain-developer worker \`$site\`* is not holding the host's current Claude credential — the copy lands but the bytes still differ after a retry. Left running deliberately (it may be in use). If it is idle it will be destroyed and rebuilt automatically within 4h; to fix it now: \`tools/domain-developer/bin/dd-recreate ${site#dd-}\`. If a freshly-created worker does the same, suspect the shared host session (see check-claude-auth.sh)." "warning"
done

exit 0
