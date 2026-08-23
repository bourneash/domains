#!/usr/bin/env bash
# Idle dd-<site> worker reaper — cattle, not pets.
#
# domain-developer workers (tools/domain-developer) are documented as
# spin-up-on-demand (README.md), but were originally started with `--restart
# unless-stopped` and no idle-timeout. Nothing ever stopped them, so once
# started they ran indefinitely — days, sometimes over a week (the 2026-08-16
# incident: dd-shoptopless.com/dd-americastrikes.com had sat idle 8 days since
# their last boot). That long-lived-container pattern is the actual root
# enabler of both dd-* auth incidents in check-dd-containers-auth.sh's header:
# the longer a worker stays up unattended, the more its independent OAuth
# credential copy has had to drift from the host's.
#
# The full fix is split across three places, and this script is only one of
# them — read all three before changing any:
#   1. tools/domain-developer/bin/domain-developer + server/server.js:
#      workers are created with NO restart policy, and any container that is
#      not currently RUNNING is destroyed and recreated from the current image
#      rather than `docker start`ed back to life. That closes the image-drift
#      hole: a stopped container object pins the image it was created from.
#   2. This script: nothing idle stays up, and no container object outlives
#      its session — we stop AND remove.
#   3. bin/dd-doctor: asserts 1 and 2 hold on every live container, so a
#      regression is caught rather than rediscovered during an incident.
#
# Why removing (not just stopping) is safe: dd-* worker state lives entirely on
# host bind mounts (tools/domain-developer/REDESIGN.md) — the container holds
# nothing that isn't trivially reconstructible. `domain-developer <site>` (CLI)
# or the panel's Start button brings it back in seconds, and the entrypoint
# copies a FRESH host credential on that boot. Removing rather than stopping
# additionally guarantees the next boot uses the CURRENT image: a stopped
# container silently pins its creation-time image forever, so a `dd-build` that
# landed while a worker sat idle-stopped would never reach it.
#
# Three reap conditions, all of which only ever apply to a container nobody is
# using:
#   a) RUNNING + idle past $IDLE_THRESHOLD_SEC  -> stop + remove
#   b) RUNNING + image != domain-developer:latest + idle past
#      $DRIFT_IDLE_GRACE_SEC                    -> stop + remove (drift)
#   c) NOT running (exited/created/dead)        -> remove once older than
#      $CORPSE_GRACE_SEC, so a crash-on-boot is still inspectable with
#      `docker logs` for a while before it is swept.
#
# Idle signal: newest mtime across the worker's host-bound state dirs
# (tools/domain-developer/state/<site>/{claude,persist}), EXCLUDING the files
# that fleet automation writes (see $EXCLUDE_NAMES). Claude Code touches files
# there (transcripts, shell snapshots, edits) on essentially every turn of real
# activity, so this is a reasonable proxy for "someone is actually using this
# shell" without needing to reach into the container. Deliberately generous by
# default (4h) — this reclaims idle capacity, it is not a session timeout; a
# human mid-thought with no recent write is exactly the false positive to
# avoid, hence the wide default and the fact that the cost of being wrong is a
# few seconds of rebuild, not lost work.
#
# The exclusion is LOAD-BEARING, not hygiene. check-dd-containers-auth.sh
# (crontab.docker job 8) pushes the host credential into every worker every
# 10 minutes, and those writes land inside this same state dir. Until that was
# accounted for, every worker read as "active 9 minutes ago" permanently and
# this reaper could never fire once — the cattle model was inert. That job also
# used to run a full `claude -p` probe inside each worker, which wrote a fresh
# transcript, security log and config backup into the state dir every tick;
# no name-based exclusion can distinguish those from human work, so the probe
# was removed rather than filtered (see that script's creds_match_host()
# header). If you add ANY new automation that writes under state/<site>/,
# either exclude it here or make it write somewhere else — otherwise you will
# silently switch this reaper off again.
#
# PORTABILITY (load-bearing, not style): this script runs from the fleet-cron
# container, which is ALPINE — `find`, `date` and `stat` there are BusyBox
# applets, not GNU. The original version used `find -printf '%T@'` and
# `date -d <RFC3339>`; BusyBox supports neither, so from cron every worker read
# as "can't determine idleness — skipping" and the reaper never once acted. It
# only ever appeared to work because it was hand-tested on the host, where
# those are GNU. (Same class of bug as the BusyBox `cp -n` silent no-op that
# cost this tool a per-site Claude cache — see REDESIGN.md's 2026-05-30
# incident. Assume nothing about coreutils in a container.)
#
# The mtime scan and the timestamp parsing are therefore done in python3, which
# is already a hard dependency here (NOTIFY uses it) and behaves identically on
# host and in Alpine. If you reintroduce a GNU-only flag, test it with
# `docker exec fleet-cron`, not just on the host.
#
# An ACTIVE worker on a stale image is never killed — someone may be mid-
# session. It is reported (Slack + log) and left alone; dd-doctor and the panel
# both surface it too. That is the single remaining way a pet can exist here,
# and it is loud rather than silent by design.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
DD_ROOT="$DOMAINS_ROOT/tools/domain-developer"
LOG="${DD_IDLE_LOG:-$DOMAINS_ROOT/tools/scripts/reap-idle-dd-workers.log}"
LOCK="${DD_IDLE_LOCK:-$DOMAINS_ROOT/tools/scripts/reap-idle-dd-workers.lock}"
LOG_MAX_BYTES="${DD_IDLE_LOG_MAX_BYTES:-2097152}"
IDLE_THRESHOLD_SEC="${DD_IDLE_THRESHOLD_SEC:-14400}"        # 4h
# A drifted worker is reaped much sooner than a merely-idle one: it is already
# wrong, so there is less reason to keep it warm. Still non-zero so a short
# pause in an active session on a just-rebuilt image doesn't yank it.
DRIFT_IDLE_GRACE_SEC="${DD_DRIFT_IDLE_GRACE_SEC:-900}"      # 15min
# How long a dead container object is kept for `docker logs` postmortem.
CORPSE_GRACE_SEC="${DD_CORPSE_GRACE_SEC:-3600}"             # 1h
CHANNEL="${DD_IDLE_CHANNEL:-domain-ops}"
# Filenames written by fleet automation rather than by a human using the
# worker. Excluded from the idle signal — see the header; getting this wrong
# disables the reaper silently.
#   .credentials.json / settings.json — pushed in every 10min by
#   check-dd-containers-auth.sh's sync_credentials().
EXCLUDE_NAMES=(.credentials.json settings.json .credentials.json.tmp settings.json.tmp)
IMAGE="${DD_IMAGE:-domain-developer:latest}"
DRY_RUN="${DD_IDLE_DRY_RUN:-0}"

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  log_size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$log_size" =~ ^[0-9]+$ ]] && (( log_size > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() {
  printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"
  [[ "$DRY_RUN" == "1" ]] && printf '%s\n' "$*"
  return 0
}

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }
NOTIFY() {
  local text="$1" color="$2"
  [[ "$DRY_RUN" == "1" ]] && { printf '[dry-run] would notify: %s\n' "$text"; return 0; }
  [[ -z "${SLACK_BOT_TOKEN:-}" ]] && return 0
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({'channel': sys.argv[1], 'attachments': [{'color': sys.argv[3], 'text': sys.argv[2], 'mrkdwn_in': ['text']}]}))
" "$CHANNEL" "$text" "$color" 2>/dev/null) || return 0
  curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" https://slack.com/api/chat.postMessage >/dev/null 2>&1 || true
}

# stop then remove. Split so a stop that times out still gets the container
# removed: leaving a stopped-but-present container behind is precisely the pet
# state this whole script exists to eliminate.
destroy() {
  local cname="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] would: docker stop %s ; docker rm -f %s\n' "$cname" "$cname"
    return 0
  fi
  docker stop "$cname" >/dev/null 2>&1
  if docker rm --force "$cname" >/dev/null 2>&1; then
    return 0
  fi
  log "$cname: docker rm FAILED — container object left behind, will retry next tick"
  return 1
}

# Newest mtime under the worker's host-bound state dirs; echoes an epoch or
# nothing. Kept as a function so the running/exited paths agree on the signal.
last_activity() {
  local site="$1" newest
  local claude_dir="$DD_ROOT/state/$site/claude"
  local persist_dir="$DD_ROOT/state/$site/persist"
  [[ -d "$claude_dir" || -d "$persist_dir" ]] || return 1
  # python3, not `find -printf`: BusyBox find has no -printf (see PORTABILITY).
  newest="$(python3 - "$claude_dir" "$persist_dir" "${EXCLUDE_NAMES[@]}" <<'PYEOF'
import os, sys
dirs = sys.argv[1:3]
exclude = set(sys.argv[3:])
newest = 0
for root_dir in dirs:
    for dirpath, _dirnames, filenames in os.walk(root_dir):
        for fn in filenames:
            if fn in exclude:
                continue
            try:
                m = os.lstat(os.path.join(dirpath, fn)).st_mtime
            except OSError:
                continue
            if m > newest:
                newest = m
if newest:
    print(int(newest))
PYEOF
)"
  [[ "$newest" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$newest"
}

# RFC3339 (as docker inspect emits it, with nanoseconds and a Z) -> epoch.
# BusyBox `date -d` rejects that format outright, so parse it in python3.
rfc3339_epoch() {
  python3 - "$1" <<'PYEOF'
import re, sys, calendar, time
v = sys.argv[1] if len(sys.argv) > 1 else ''
m = re.match(r'^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})', v)
if not m:
    raise SystemExit(1)
y, mo, d, h, mi, sec = (int(x) for x in m.groups())
tz = re.search(r'([+-])(\d{2}):?(\d{2})$', v)
epoch = calendar.timegm((y, mo, d, h, mi, sec, 0, 0, 0))
if tz:
    off = (int(tz.group(2)) * 3600 + int(tz.group(3)) * 60) * (1 if tz.group(1) == '+' else -1)
    epoch -= off
# no tz suffix and no 'Z' -> docker always emits UTC, so treat it as UTC anyway
print(epoch)
PYEOF
}

# Activity epoch for a worker, with a boot-time floor.
#
# A worker that was created but never actually used has EMPTY state dirs —
# nothing has written a transcript or a shell snapshot yet — so last_activity()
# has nothing to report. Skipping those (the obvious safe-looking default) is
# wrong in exactly the wrong direction: a never-used worker is the MOST
# disposable container in the fleet, and skipping it means an accidental
# `domain-developer <site> true` leaves an immortal pet behind that no reap
# condition can ever match. So fall back to the container's own StartedAt: an
# unused worker then ages out on the normal idle clock from the moment it
# booted.
activity_epoch() {
  local site="$1" cname="$2" epoch started
  if epoch="$(last_activity "$site")"; then
    printf '%s' "$epoch"
    return 0
  fi
  started="$(docker inspect --format '{{.State.StartedAt}}' "$cname" 2>/dev/null)"
  epoch="$(rfc3339_epoch "$started" 2>/dev/null || echo '')"
  [[ "$epoch" =~ ^[0-9]+$ ]] && (( epoch > 0 )) || return 1
  printf '%s' "$epoch"
}

want_image_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
[[ -n "$want_image_id" ]] || log "warning: image $IMAGE not present — image-drift reaping disabled this tick"

# -a: we also want the dead container objects, which are pets too.
mapfile -t CONTAINERS < <(docker ps -a --filter "name=^dd-" --format '{{.Names}}' | grep -v '^dd-panel$' | sort)

if [[ "${#CONTAINERS[@]}" -eq 0 ]]; then
  log "no dd-* worker containers — nothing to check"
  exit 0
fi

now="$(date +%s)"
reaped=()
swept=()
drifted_active=()

for cname in "${CONTAINERS[@]}"; do
  site="${cname#dd-}"
  status="$(docker inspect --format '{{.State.Status}}' "$cname" 2>/dev/null | tr -d '[:space:]')"

  # ── (c) not running: a corpse. Sweep it once the postmortem window passes.
  if [[ "$status" != "running" ]]; then
    finished="$(docker inspect --format '{{.State.FinishedAt}}' "$cname" 2>/dev/null)"
    finished_epoch="$(rfc3339_epoch "$finished" 2>/dev/null || echo 0)"
    # A never-started ("created") container has a zero FinishedAt; treat that
    # as immediately sweepable rather than never.
    if (( finished_epoch > 0 )) && (( now - finished_epoch < CORPSE_GRACE_SEC )); then
      log "$cname: $status $(( (now - finished_epoch) / 60 ))min ago — keeping briefly for \`docker logs\` postmortem"
      continue
    fi
    log "$cname: $status and past the $(( CORPSE_GRACE_SEC / 60 ))min postmortem window — removing (a stopped worker pins its creation-time image; nothing durable is in it)"
    destroy "$cname" && swept+=("$cname")
    continue
  fi

  # ── running: how long since anyone actually used it?
  if ! newest="$(activity_epoch "$site" "$cname")"; then
    log "$cname: could not determine last-activity mtime under $DD_ROOT/state/$site, and its StartedAt is unreadable — skipping (can't judge idleness safely)"
    continue
  fi
  idle_sec=$(( now - newest ))

  # ── (b) image drift.
  drifted=0
  if [[ -n "$want_image_id" ]]; then
    have_image_id="$(docker inspect --format '{{.Image}}' "$cname" 2>/dev/null || true)"
    [[ -n "$have_image_id" && "$have_image_id" != "$want_image_id" ]] && drifted=1
  fi

  if (( drifted )); then
    if (( idle_sec >= DRIFT_IDLE_GRACE_SEC )); then
      log "$cname: running an image older than $IMAGE and idle $(( idle_sec / 60 ))min — destroying so the next boot picks up the current image"
      destroy "$cname" && reaped+=("$cname (stale image)")
    else
      log "$cname: running an image older than $IMAGE but active $(( idle_sec / 60 ))min ago — NOT killing a live session; recreate it when convenient"
      drifted_active+=("$cname")
    fi
    continue
  fi

  # ── (a) plain idle.
  if (( idle_sec < IDLE_THRESHOLD_SEC )); then
    log "$cname: active $(( idle_sec / 60 ))min ago — leaving up"
    continue
  fi

  log "$cname: idle $(( idle_sec / 3600 ))h (threshold $(( IDLE_THRESHOLD_SEC / 3600 ))h) — destroying (state on host binds, nothing lost; bring it back with \`domain-developer $site\`)"
  destroy "$cname" && reaped+=("$cname")
done

if [[ "${#reaped[@]}" -gt 0 ]]; then
  NOTIFY ":zzz: Reaped ${#reaped[@]} idle domain-developer worker(s): $(printf '`%s` ' "${reaped[@]}"). Containers destroyed, not just stopped — all state is on host binds, so nothing is lost and the next start rebuilds from the current image. Bring one back with \`domain-developer <site>\`." "warning"
fi
if [[ "${#drifted_active[@]}" -gt 0 ]]; then
  NOTIFY ":warning: ${#drifted_active[@]} domain-developer worker(s) are running an image older than \`$IMAGE\` but still in active use, so they were left alone: $(printf '`%s` ' "${drifted_active[@]}"). Recreate when convenient: \`tools/domain-developer/bin/dd-recreate <site>\`." "warning"
fi
if [[ "${#swept[@]}" -gt 0 ]]; then
  log "swept ${#swept[@]} dead container object(s): ${swept[*]}"
fi

exit 0
