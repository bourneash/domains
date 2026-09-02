#!/usr/bin/env bash
# sync-site-git-identity.sh — give every site repo its OWN git identity.
#
# WHY THIS EXISTS
# 2026-09-01: ~800 commits across 25+ site repos were authored as
# "Broadway Show Girls Desk <desk@broadwayshowgirls.com>". That is the HOST's
# global git identity, and only four site repos had ever set a local one — so
# every commit made from the host (any Claude Code session, any manual fix)
# landed on every site under one site's persona. Containerised roles were never
# affected: each compose file already exports GIT_USER_NAME / GIT_USER_EMAIL,
# so `docker compose run worker` commits as e.g. "ShopPinkFlamingo Bot".
#
# The identities were therefore already defined and already correct — the host
# just never used them. This copies each site's declared bot identity from its
# docker-compose.yml into that repo's local git config, so host-side and
# container-side commits finally agree.
#
# tools/fleet-git/lib/gitexec.js already documents this as an invariant
# ("Every site repo in this fleet sets a local user.name/user.email"). Until
# this script ran, that was aspirational.
#
# Local config lives in .git/config, which is NOT committed and does not survive
# a fresh clone or a submodule re-init. Re-run this after either. It is
# idempotent and safe to run any time.
#
# Usage:
#   tools/scripts/sync-site-git-identity.sh          # apply
#   tools/scripts/sync-site-git-identity.sh --check  # report only, exit 1 if drifted
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

applied=0
drifted=0
derived=()

for d in "$ROOT"/sites/*/; do
  site="$(basename "$d")"
  [[ -e "$d/.git" ]] || continue

  compose="$d/docker-compose.yml"
  name="$(grep -oP 'GIT_USER_NAME:\s*"?\K[^"\n]+' "$compose" 2>/dev/null | head -1 || true)"
  email="$(grep -oP 'GIT_USER_EMAIL:\s*"?\K[^"\n]+' "$compose" 2>/dev/null | head -1 || true)"

  # Scaffolds have no docker-compose.yml yet, so nothing declares an identity
  # for them. Derive one from the domain rather than leaving them on the host's
  # global identity — that is the whole failure this script exists to stop, and
  # a scaffold gets committed to (bootstrap, onboarding, link sweeps) long
  # before it gets an ops runtime. Same shape the stamped sites use, so when a
  # compose does land it will agree instead of fighting.
  if [[ -z "$name" || -z "$email" ]]; then
    derived+=("$site")
    name="${site%%.*} Bot"
    email="bot@${site}"
  fi

  current="$(git -C "$d" config --local user.email 2>/dev/null || true)"
  [[ "$current" == "$email" ]] && continue

  drifted=$((drifted + 1))
  if (( CHECK )); then
    printf 'DRIFT %-26s local=%-34s want=%s\n' "$site" "${current:-<none>}" "$email"
  else
    git -C "$d" config --local user.name  "$name"
    git -C "$d" config --local user.email "$email"
    printf 'set   %-26s %s <%s>\n' "$site" "$name" "$email"
    applied=$((applied + 1))
  fi
done

if (( ${#derived[@]} )); then
  printf '\nidentity derived from the domain (%d — no docker-compose.yml yet):\n  %s\n' \
    "${#derived[@]}" "${derived[*]}"
fi

if (( CHECK )); then
  printf '\n%d repo(s) drifted from their declared identity\n' "$drifted"
  (( drifted == 0 ))
else
  printf '\napplied to %d repo(s)\n' "$applied"
fi
