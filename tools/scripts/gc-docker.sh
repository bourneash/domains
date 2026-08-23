#!/usr/bin/env bash
# Fleet Docker garbage collector — reclaim build exhaust, never data.
#
# WHY THIS EXISTS
# The fleet builds per-site images repeatedly (27 site-cron + 26 site-worker
# definitions before the shared-image migration; still a rebuild per image bump
# after it). Every rebuild that moves a :latest tag orphans the previous image,
# and BuildKit keeps its intermediate layers indefinitely. Nothing ever
# collected either. Measured 2026-08-23 before the first run: 587 images /
# 241 GB with 139 GB reclaimable, 159 dangling images holding ~100 GB, and a
# 158 GB build cache with 40 GB reclaimable — on a root filesystem at 71%.
#
# WHAT IT TOUCHES — and the hard line it does not cross
#   YES  dangling images        (untagged AND unreferenced by any container)
#   YES  build cache            (regenerable by definition)
#   YES  stopped containers     ONLY with --containers, and never a dd-* or
#                               *-cron one (those have their own lifecycle
#                               owners: reap-idle-dd-workers.sh and the site
#                               compose files)
#   NO   named volumes          NEVER. Not with a flag. See below.
#   NO   tagged images          NEVER, even if unused — a tagged image is
#                               someone's pinned rollback.
#
# VOLUMES ARE NOT NEGOTIABLE. `docker volume prune` would report ~45 GB
# reclaimable here and it is forbidden. tools/domain-developer/REDESIGN.md
# records the 2026-05-30 incident where raw volume deletion destroyed every
# site's Claude cache/config because a verification gate was skipped. The only
# sanctioned volume-deletion path on this host is a verified-delete tool that
# proves the data exists elsewhere first (bin/dd-reclaim-volumes is the
# reference implementation). If you are here to reclaim volume space, go write
# that check — do not add a flag to this script.
#
# Safe to run while the fleet is live: dangling images are by definition not
# in use by any container, and pruning build cache only costs a slower next
# build.
#
# Usage:
#   gc-docker.sh                 # images + build cache (the cron default)
#   gc-docker.sh --dry-run       # report only, touch nothing
#   gc-docker.sh --containers    # also sweep non-fleet stopped containers
#   gc-docker.sh --cache-keep 24h  # keep build cache newer than this
#   gc-docker.sh --cache-all     # reclaim ALL unused build cache (see below)
#
# ON --cache-all AND THE until= FILTER
# `docker builder prune --filter until=<dur>` matches on the cache record's
# LAST USED field, and a large share of this host's cache records have no
# LAST USED at all (created by a build, never re-hit). Those never match any
# until= window, so the filtered prune reports "Total: 0B" while
# `docker system df` simultaneously reports tens of GB of reclaimable cache.
# Measured 2026-08-23: 158 GB cache, 73 GB reclaimable, `until=168h` freed 0B.
# That is a silent no-op — the exact failure shape that made the first idle
# reaper useless — so this script now cross-checks the two numbers and says so
# (see the cache-stall warning below) instead of reporting success.
# `--cache-all` drops the filter and reclaims every UNUSED cache record. It is
# still not `-a`: cache in use by a live build is never touched. The only cost
# is a colder next build.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
LOG="${GC_DOCKER_LOG:-$DOMAINS_ROOT/tools/scripts/gc-docker.log}"
LOCK="${GC_DOCKER_LOCK:-$DOMAINS_ROOT/tools/scripts/gc-docker.lock}"
LOG_MAX_BYTES="${GC_DOCKER_LOG_MAX_BYTES:-2097152}"
CHANNEL="${GC_DOCKER_CHANNEL:-domain-ops}"
# Build cache younger than this is kept — a fresh cache is what makes the next
# image bump fast, and the space it holds is small compared to the long tail.
CACHE_KEEP="${GC_DOCKER_CACHE_KEEP:-168h}"
# Only shout on Slack when a run reclaims something worth noticing; routine
# nightly runs that free a few hundred MB stay silent (healthy = quiet, same
# convention as the engineer pulse).
NOTIFY_MIN_GB="${GC_DOCKER_NOTIFY_MIN_GB:-5}"
DRY_RUN=0
DO_CONTAINERS=0
CACHE_ALL=0
# If the build cache reports at least this much reclaimable but a prune pass
# frees essentially nothing, that is a stalled filter, not a clean cache.
CACHE_STALL_WARN_GB="${GC_DOCKER_CACHE_STALL_WARN_GB:-10}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=1 ;;
    --containers) DO_CONTAINERS=1 ;;
    --cache-keep) shift; CACHE_KEEP="${1:-168h}" ;;
    --cache-all)  CACHE_ALL=1 ;;
    -h|--help)    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
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

# Total bytes docker is holding, so before/after is one honest number rather
# than the sum of each prune's self-reported reclaim (which double-counts
# shared layers).
docker_bytes() {
  docker system df --format '{{.Type}}\t{{.Size}}' 2>/dev/null | python3 -c "
import sys
def parse(s):
    s = s.strip()
    for unit, mult in (('TB',1e12),('GB',1e9),('MB',1e6),('kB',1e3),('B',1)):
        if s.endswith(unit):
            try: return float(s[:-len(unit)]) * mult
            except ValueError: return 0.0
    return 0.0
total = 0.0
for line in sys.stdin:
    if '\t' not in line: continue
    kind, size = line.split('\t', 1)
    # Volumes are never touched by this script; excluding them from the
    # before/after keeps the reported reclaim attributable to what we did.
    if kind.strip().lower().startswith('local volume'): continue
    total += parse(size)
print(int(total))
" 2>/dev/null || echo 0
}

gb() { python3 -c "print(f'{int($1)/1e9:.1f}')" 2>/dev/null || echo '?'; }

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  log "docker daemon unreachable — nothing to do"
  exit 0
fi

before="$(docker_bytes)"
dangling_n="$(docker images -f dangling=true -q 2>/dev/null | wc -l)"
log "start: docker holding $(gb "$before") GB (excl. volumes), $dangling_n dangling image(s)"

# ── 1. dangling images ──────────────────────────────────────────────────────
# `-f dangling=true` is untagged AND unreferenced. A tagged image that merely
# isn't running is NOT dangling and is never touched here — that is the whole
# reason this uses `image prune` without -a.
if (( dangling_n > 0 )); then
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would: docker image prune -f   ($dangling_n dangling images)"
  else
    out="$(docker image prune -f 2>&1 | tail -1)"
    log "image prune: ${out:-done}"
  fi
else
  log "no dangling images"
fi

# ── 2. build cache ──────────────────────────────────────────────────────────
# Reclaimable-cache figure straight from the daemon, so we can tell a genuinely
# clean cache from a filter that matched nothing (see the header note).
cache_reclaimable_gb() {
  docker system df --format '{{.Type}}\t{{.Reclaimable}}' 2>/dev/null | python3 -c "
import sys
def parse(s):
    s = s.strip().split('(')[0].strip()
    for unit, mult in (('TB',1e12),('GB',1e9),('MB',1e6),('kB',1e3),('B',1)):
        if s.endswith(unit):
            try: return float(s[:-len(unit)]) * mult
            except ValueError: return 0.0
    return 0.0
for line in sys.stdin:
    if '\t' not in line: continue
    kind, rec = line.split('\t', 1)
    if kind.strip().lower().startswith('build cache'):
        print(f'{parse(rec)/1e9:.1f}'); break
else:
    print('0.0')
" 2>/dev/null || echo '0.0'
}

cache_before_gb="$(cache_reclaimable_gb)"
if [[ "$DRY_RUN" == "1" ]]; then
  if (( CACHE_ALL )); then
    log "[dry-run] would: docker builder prune -f   (all unused cache; ${cache_before_gb} GB reclaimable)"
  else
    log "[dry-run] would: docker builder prune -f --filter until=$CACHE_KEEP   (${cache_before_gb} GB reported reclaimable)"
  fi
else
  if (( CACHE_ALL )); then
    out="$(docker builder prune -f 2>&1 | tail -1)"
    log "builder prune (all unused): ${out:-done}"
  else
    out="$(docker builder prune -f --filter "until=$CACHE_KEEP" 2>&1 | tail -1)"
    log "builder prune (keep <$CACHE_KEEP): ${out:-done}"
  fi
  cache_after_gb="$(cache_reclaimable_gb)"
  # Cross-check: plenty reportedly reclaimable, prune moved nothing.
  if python3 -c "
import sys
before, after, thresh = float('$cache_before_gb'), float('$cache_after_gb'), float('$CACHE_STALL_WARN_GB')
sys.exit(0 if after >= thresh and (before - after) < 1.0 else 1)" 2>/dev/null; then
    log "WARNING: build cache still reports ${cache_after_gb} GB reclaimable but this pass freed ~nothing."
    log "         until= matches on LAST USED and much of this cache has none — re-run with --cache-all to actually reclaim it."
  fi
fi

# ── 3. stopped containers (opt-in only) ─────────────────────────────────────
# Deliberately NOT the default and deliberately not `container prune`, which
# would sweep any exited dd-* worker inside its postmortem window and any
# site-cron container someone stopped on purpose. Those two families have
# owners; everything else is fair game only when asked.
if (( DO_CONTAINERS )); then
  mapfile -t stopped < <(docker ps -a --filter status=exited --filter status=created \
      --format '{{.Names}}' 2>/dev/null | grep -vE '^dd-|-cron$' || true)
  if [[ "${#stopped[@]}" -eq 0 ]]; then
    log "no sweepable stopped containers (dd-* and *-cron are excluded by policy)"
  else
    for c in "${stopped[@]}"; do
      if [[ "$DRY_RUN" == "1" ]]; then
        log "[dry-run] would remove stopped container: $c"
      else
        docker rm "$c" >/dev/null 2>&1 && log "removed stopped container: $c"
      fi
    done
  fi
fi

after="$(docker_bytes)"
freed=$(( before - after ))
(( freed < 0 )) && freed=0
log "end: docker holding $(gb "$after") GB (excl. volumes) — reclaimed $(gb "$freed") GB"

if [[ "$DRY_RUN" != "1" ]]; then
  freed_gb="$(gb "$freed")"
  if python3 -c "import sys; sys.exit(0 if float('$freed_gb') >= float('$NOTIFY_MIN_GB') else 1)" 2>/dev/null; then
    NOTIFY ":broom: Docker GC reclaimed *${freed_gb} GB* on the fleet host (dangling images + build cache older than ${CACHE_KEEP}). Now holding $(gb "$after") GB. Volumes and tagged images untouched — see \`tools/scripts/gc-docker.sh\`." "good"
  fi
fi

exit 0
