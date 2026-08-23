#!/usr/bin/env bash
# reclaim-docker-volumes.sh [--yes] [--filter REGEX] [--min-age-days N]
#
# The ONLY sanctioned way to delete Docker volumes on this host.
#
# ─────────────────────────────────────────────────────────────────────────────
# READ THIS BEFORE CHANGING ANYTHING HERE
#
# On 2026-05-30 a raw `docker volume rm` sweep destroyed every site's Claude
# cache/config. A verification gate had already reported "host has fewer files"
# for 8 of 9 sites and the deletion proceeded anyway. On overlay2 the space is
# reclaimed immediately, so it was unrecoverable without root — and the only
# reason it was a cache loss instead of a catastrophe was that the durability
# redesign had already moved the important data onto host binds.
# (tools/domain-developer/REDESIGN.md)
#
# The lesson encoded here: a volume is deleted ONLY when this script can prove,
# from the volume's own contents, that losing it is safe. Not "probably safe",
# not "it looks like a cache". Proof, or it stays.
#
# `docker volume prune` remains forbidden. tools/scripts/gc-docker.sh will not
# touch volumes and has no flag to make it.
# ─────────────────────────────────────────────────────────────────────────────
#
# SAFETY MODEL — a volume must clear EVERY gate to be deletable:
#   1. Not in use by any container (running OR stopped) — AND, where the class
#      says so, not owned by a live compose project either. Gate 1 alone is a
#      trap: the fleet's workers are one-shot `run --rm`, so a volume every
#      site depends on looks "unused" at literally every moment nobody happens
#      to be mid-role. Caught in dry-run before it deleted 25 warm caches.
#   2. Matches a KNOWN-REGENERABLE class with an explicit reason (below).
#      Anything unrecognised is reported and kept, forever, by design.
#   3. Older than --min-age-days (default 7), so a volume created by work in
#      flight is never swept.
#   4. Passes that class's own content probe — e.g. a node_modules volume must
#      actually look like node_modules, so a mislabelled volume full of real
#      data cannot be deleted by name alone.
#
# Dry-run by default. --yes is required to delete anything.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
LOG="${RECLAIM_VOL_LOG:-$DOMAINS_ROOT/tools/scripts/reclaim-docker-volumes.log}"
LOCK="${RECLAIM_VOL_LOCK:-$DOMAINS_ROOT/tools/scripts/reclaim-docker-volumes.lock}"
MIN_AGE_DAYS="${RECLAIM_VOL_MIN_AGE_DAYS:-7}"
FILTER=""
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)          APPLY=1 ;;
    --filter)       shift; FILTER="${1:-}" ;;
    --min-age-days) shift; MIN_AGE_DAYS="${1:-7}" ;;
    -h|--help)      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

exec 9>"$LOCK"
flock -n 9 || { echo "another run is in progress"; exit 0; }

log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }
say() { printf '%s\n' "$*"; log "$*"; }

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }

# ── in-use set: any volume referenced by ANY container, running or not ──────
in_use="$(docker ps -a --format '{{.Names}}' | while read -r c; do
    docker inspect "$c" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}
{{end}}{{end}}' 2>/dev/null
  done | sort -u)"

# ── regenerable classes ─────────────────────────────────────────────────────
# name-regex :: human reason :: probe (runs in a throwaway alpine with the
# volume at /v; must print exactly OK for the volume to be considered proven)
#
# To add a class you must be able to answer, in one sentence, what regenerates
# the data and how the probe proves this volume is that thing.
classify() {
  local v="$1"
  case "$v" in
    *_site_node_modules)
      # Deletable ONLY when the owning compose project no longer exists —
      # i.e. the volume was left behind by a COMPOSE_PROJECT_NAME change and
      # nothing will ever mount it again.
      #
      # A node_modules volume for a LIVE project is a warm cache the fleet
      # actively uses: dropping it forces a multi-minute `npm ci` on that
      # site's next role AND re-downloads its Playwright browser. Regenerable
      # is not the same as disposable.
      echo "orphan-node_modules::compose project no longer exists; nothing will mount it again::test -d /v/.package-lock.json -o -d /v/astro -o -d /v/@astrojs -o -d /v/.bin && echo OK"
      ;;
    *)
      echo "" ;;
  esac
}

# Compose project names declared by the sites that exist right now.
live_projects() {
  local d
  for d in "${DOMAINS_ROOT}"/sites/*/; do
    [[ -f "${d}docker-compose.yml" ]] || continue
    grep -m1 -E '^name:' "${d}docker-compose.yml" 2>/dev/null | awk '{print $2}'
  done | sort -u
}

now="$(date +%s)"
kept=0; proven=0; removed=0; skipped_inuse=0; unknown=0
declare -a to_remove=()

say "=== reclaim-docker-volumes ($( ((APPLY)) && echo APPLY || echo DRY-RUN ), min-age ${MIN_AGE_DAYS}d) ==="

while read -r v; do
  [[ -n "$v" ]] || continue
  [[ -n "$FILTER" && ! "$v" =~ $FILTER ]] && continue

  if grep -qxF "$v" <<<"$in_use"; then
    skipped_inuse=$((skipped_inuse+1)); continue
  fi

  spec="$(classify "$v")"
  if [[ -z "$spec" ]]; then
    unknown=$((unknown+1))
    say "  KEEP    $v — unrecognised class; this script will never delete what it cannot prove is regenerable"
    continue
  fi
  cls="${spec%%::*}"; rest="${spec#*::}"
  reason="${rest%%::*}"; probe="${rest#*::}"

  # Live-project gate for orphan-only classes.
  if [[ "$cls" == orphan-* ]]; then
    proj="${v%_site_node_modules}"
    if live_projects | grep -qxF "$proj"; then
      kept=$((kept+1))
      say "  KEEP    $v — compose project '${proj}' is LIVE; this is a warm cache in daily use, not garbage"
      continue
    fi
  fi

  created="$(docker volume inspect "$v" --format '{{.CreatedAt}}' 2>/dev/null)"
  cepoch="$(python3 -c "
import re,sys,calendar
m=re.match(r'(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})', '''$created''')
print(calendar.timegm(tuple(int(x) for x in m.groups())+(0,0,0)) if m else 0)" 2>/dev/null || echo 0)"
  age_days=$(( (now - cepoch) / 86400 ))
  if (( cepoch > 0 && age_days < MIN_AGE_DAYS )); then
    kept=$((kept+1))
    say "  KEEP    $v — only ${age_days}d old (min ${MIN_AGE_DAYS}d)"
    continue
  fi

  if ! docker run --rm -v "$v":/v alpine:3.21 sh -c "$probe" 2>/dev/null | grep -qx OK; then
    kept=$((kept+1))
    say "  KEEP    $v — content probe for '${cls}' did NOT match; contents are not what the name claims"
    continue
  fi

  proven=$((proven+1))
  to_remove+=("$v")
  say "  PROVEN  $v — ${cls}: ${reason} (age ${age_days}d)"
done < <(docker volume ls --format '{{.Name}}' | sort)

echo
if (( ${#to_remove[@]} == 0 )); then
  say "Nothing proven safe to delete. kept=$kept unknown=$unknown in-use=$skipped_inuse"
  exit 0
fi

if (( ! APPLY )); then
  say "DRY RUN — ${#to_remove[@]} volume(s) proven safe. Re-run with --yes to delete."
  say "kept=$kept unknown=$unknown in-use=$skipped_inuse"
  exit 0
fi

for v in "${to_remove[@]}"; do
  if docker volume rm "$v" >/dev/null 2>&1; then
    removed=$((removed+1)); say "  REMOVED $v"
  else
    say "  FAILED  $v — still referenced? left in place"
  fi
done
say "removed=$removed kept=$kept unknown=$unknown in-use=$skipped_inuse"
