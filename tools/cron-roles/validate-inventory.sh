#!/usr/bin/env bash
# Cross-check a site's role bodies, crontab and kill-switches against each other.
#
# WHY: role bodies are GENERATED, and a generated awareness block can name a
# sibling role that does not exist on the site. That happened on
# eastcoastrappers.com — engineer.md and watchdog.md both instructed the model
# to coordinate with a `promoter` that was not installed. A role told to file
# work to a non-existent sibling either drops the work or invents a path to it;
# the handoff protocol calls that out ("never a dangling reference") but nothing
# mechanically enforced it.
#
# Also catches the inverse drift, which is worse because it is invisible:
# a role installed with a body and a dispatch branch but NO crontab line —
# it looks installed and never runs.
#
# Usage: validate-inventory.sh <domain> [domain ...]
#        validate-inventory.sh --all
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAILED=0

# Roles that legitimately have no ops/roles/<name>.md: they are script-only
# (cron-direct, zero model) and are referenced by name in prose all the time.
SCRIPT_ONLY=" deployer guide-publisher watchdog-wrapper "

sites=()
if [[ "${1:-}" == "--all" ]]; then
  for d in "$ROOT"/sites/*/ops/roles; do [[ -d "$d" ]] && sites+=("$(basename "$(dirname "$(dirname "$d")")")"); done
else
  sites=("$@")
fi
[[ "${#sites[@]}" -gt 0 ]] || { echo "usage: $0 <domain>... | --all" >&2; exit 2; }

for site in "${sites[@]}"; do
  SITE_DIR="$ROOT/sites/$site"
  ROLES_DIR="$SITE_DIR/ops/roles"
  CRONTAB="$SITE_DIR/ops/docker/crontab.docker"
  [[ -d "$ROLES_DIR" ]] || { echo "$site: no ops/roles — skipped"; continue; }

  present=" $(ls "$ROLES_DIR" 2>/dev/null | sed 's/\.md$//' | tr '\n' ' ') "
  errors=()    # broken instructions — a role is told to talk to something absent
  warns=()     # inert but untidy — a body nothing ever runs

  # 1. Two different signals, two different severities.
  #
  #    ERROR: a literal `assigned_role: <absent-role>` in a task template. This
  #    is what a model actually copies, so it produces real, silently-dropped
  #    handoffs regardless of what the surrounding prose says.
  #
  #    WARN: a prose mention of an absent role with no disclaimer near it.
  #
  #    An earlier version treated prose mentions as errors with a LINE-based
  #    negation check, and flagged three sites whose bodies plainly said "this
  #    site has no `engineer` role" — because the disclaimer sat on the previous
  #    line. Negation is now checked over a window, and prose alone never fails.
  known=" $(ls "$ROOT/tools/cron-roles/archetypes" 2>/dev/null | tr '\n' ' ') $present "

  for f in "$ROLES_DIR"/*.md; do
    [[ -f "$f" ]] || continue
    self="$(basename "$f" .md)"

    # -- ERROR: literal assigned_role: pointing at a role that is not installed
    while IFS= read -r referenced; do
      [[ -n "$referenced" ]] || continue
      [[ "$referenced" == "human-triage" || "$referenced" == "$self" ]] && continue
      [[ "$present" == *" $referenced "* ]] && continue
      [[ "$SCRIPT_ONLY" == *" $referenced "* ]] && continue
      errors+=("$self.md has a task template with 'assigned_role: $referenced' — not installed here, so that work is dropped")
    done < <(grep -ohE '^ *assigned_role: *`?[a-z][a-z0-9-]+' "$f" \
             | sed -E 's/.*assigned_role: *`?//' | sort -u)

    # -- WARN: prose naming an absent role with no disclaimer within 3 lines
    while IFS= read -r referenced; do
      [[ -n "$referenced" ]] || continue
      [[ "$referenced" == "$self" || "$referenced" == "human-triage" ]] && continue
      [[ "$known" == *" $referenced "* ]] || continue
      [[ "$present" == *" $referenced "* ]] && continue
      [[ "$SCRIPT_ONLY" == *" $referenced "* ]] && continue
      if ! grep -nE "\`$referenced\`" "$f" \
         | cut -d: -f1 \
         | while read -r ln; do
             sed -n "$((ln>3?ln-3:1)),$((ln+3))p" "$f" \
               | grep -qiE 'no |not |never |absent|disabled|does not exist|human-triage|there is|retired' && echo ok
           done | grep -q ok; then
        warns+=("$self.md mentions \`$referenced\` (not installed) with no nearby disclaimer")
      fi
    done < <(grep -ohE '`[a-z][a-z0-9-]{2,}`' "$f" | tr -d '`' | sort -u)
  done

  # 2. Every installed role with a body must be scheduled, or explicitly
  #    disabled by a kill-switch file.
  if [[ -f "$CRONTAB" ]]; then
    for f in "$ROLES_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      role="$(basename "$f" .md)"
      # watchdog is cron-direct: it has a body but is invoked by its own runner.
      if [[ "$role" == "watchdog" ]]; then
        grep -q 'run-watchdog.sh' "$CRONTAB" \
          || warns+=("watchdog has a body but no run-watchdog.sh crontab line")
        continue
      fi
      if ! grep -qE "run-worker\.sh +$role( |\$)" "$CRONTAB"; then
        # affiliate-editor was RETIRED fleet-wide 2026-08-25 (superseded by
        # tools/affiliate-sentinel). Its body lingering unscheduled is expected.
        if [[ "$role" != "affiliate-editor" && ! -f "$SITE_DIR/ops/.${role}-disabled" ]]; then
          warns+=("$role has a body but no crontab line and no ops/.${role}-disabled — dead role")
        fi
      fi
    done
  fi

  # NOTE: a role that is both scheduled AND kill-switched is CORRECT, not a
    # fault. run-worker.sh checks ops/.<role>-disabled and no-ops without
    # spinning a container; the flag is bind-mounted precisely so disabling
    # needs no crontab edit or rebuild. An earlier version of this script
    # flagged that combination and produced 16 false positives on the first
    # fleet run — which is how a checker gets ignored.

  if [[ "${#errors[@]}" -eq 0 && "${#warns[@]}" -eq 0 ]]; then
    echo "PASS $site — $(echo "$present" | wc -w) role(s), inventory consistent"
  elif [[ "${#errors[@]}" -eq 0 ]]; then
    echo "WARN $site"
    printf '  · %s\n' "${warns[@]}"
  else
    FAILED=1
    echo "FAIL $site"
    printf '  ✗ %s\n' "${errors[@]}"
    [[ "${#warns[@]}" -gt 0 ]] && printf '  · %s\n' "${warns[@]}"
  fi
done

exit "$FAILED"
