#!/usr/bin/env bash
# audit-disabled-flags.sh — show every role currently paused by a flag, and
# loudly flag any ACTIVE crontab role that's silently disabled.
#
# Why: the panel pauses a role with ops/.<role>-disabled. These flags are easy
# to leave behind after testing (they're often root-owned, set by the panel
# container). A stale flag on an active role means that role has silently
# stopped running — exactly the "why did this role stop?" mystery. This audit
# makes those visible with owner + age, cross-referenced against each site's
# active (uncommented) crontab lines.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/sites" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -d "$ROOT/sites" ]]; then echo "could not locate repo root (no sites/ dir)"; exit 2; fi
cd "$ROOT"

found_any=0
silent=0

for opsdir in sites/*/ops; do
  [[ -d "$opsdir" ]] || continue
  site="$(echo "$opsdir" | cut -d/ -f2)"
  crontab="$opsdir/docker/crontab.docker"

  # Active (uncommented) roles for this site, from run-worker.sh <role> lines.
  active_roles=""
  if [[ -f "$crontab" ]]; then
    active_roles="$(grep -E '^[0-9*]' "$crontab" 2>/dev/null \
      | grep -oE 'run-worker\.sh +[A-Za-z0-9._-]+' | awk '{print $2}' | sort -u)"
  fi

  for flag in "$opsdir"/.*-disabled; do
    [[ -e "$flag" ]] || continue
    found_any=1
    base="$(basename "$flag")"            # .<role>-disabled
    role="${base#.}"; role="${role%-disabled}"
    meta="$(stat -c 'owner=%U  set=%y' "$flag" 2>/dev/null | cut -d. -f1)"
    if echo "$active_roles" | grep -qx "$role"; then
      echo "⚠️  $site : $role is DISABLED but is an ACTIVE crontab role — it is silently NOT running.  ($meta)"
      silent=1
    else
      echo "·   $site : $role disabled (not an active scheduled role — likely intentional/on-demand).  ($meta)"
    fi
  done
done

echo
if [[ $found_any -eq 0 ]]; then
  echo "No .<role>-disabled flags anywhere — nothing is paused."
elif [[ $silent -eq 1 ]]; then
  echo "⚠️  One or more ACTIVE roles are paused. If unintended, re-enable from the"
  echo "    panel (Resume) or: rm sites/<site>/ops/.<role>-disabled"
else
  echo "All disabled flags are on non-active roles — no active schedule is being blocked."
fi
