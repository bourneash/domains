#!/usr/bin/env bash
# check-index-drift.sh — verify sites/ dir, DOMAINS_INDEX.md, and sites.yml are in sync.
# Usage: bash tools/scripts/check-index-drift.sh
# Exits non-zero if any drift is detected.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAINS_INDEX="$REPO_ROOT/DOMAINS_INDEX.md"
SITES_YML="$REPO_ROOT/tools/site-tracker/sites.yml"

# Collect actual site repos only. `sites/` also contains an ops-only example directory;
# requiring a submodule gitfile or a site/ app avoids treating that as a domain site.
mapfile -t SITE_DIRS < <(find "$REPO_ROOT/sites" -mindepth 1 -maxdepth 1 -type d \( -name '*' \) \
  -exec sh -c 'for path; do [ -e "$path/.git" ] || [ -d "$path/site" ] && basename "$path"; done' sh {} + | sort)

# Collect every registered domain. Some parked entries already have a repo, while
# others are intentionally index-only, so use a separate active/scaffolded list
# for the reverse (index-to-folder) check below.
mapfile -t INDEX_DOMAINS < <(grep -E '^\|\s+[a-z0-9]' "$DOMAINS_INDEX" \
  | awk -F'|' '{print $2}' | tr -d ' \t' | sort)
mapfile -t DEPLOY_INDEX_DOMAINS < <(awk '/^## Parked/{exit} /^\|[[:space:]]*[a-z0-9]/{split($0, fields, "|"); gsub(/[ \t]/, "", fields[2]); print fields[2]}' "$DOMAINS_INDEX" | sort)

# Collect domains in sites.yml (lines ending in ':' at the start of a site block)
mapfile -t YML_DOMAINS < <(grep -E '^  [a-z0-9].*\..*:$' "$SITES_YML" \
  | sed 's/://; s/^  //' | sort)

DRIFT=0

echo "=== sites/ vs DOMAINS_INDEX.md ==="
for d in "${SITE_DIRS[@]}"; do
  if ! printf '%s\n' "${INDEX_DOMAINS[@]}" | grep -qx "$d"; then
    echo "  MISSING from DOMAINS_INDEX.md: $d"
    DRIFT=$((DRIFT + 1))
  fi
done
for d in "${DEPLOY_INDEX_DOMAINS[@]}"; do
  if ! printf '%s\n' "${SITE_DIRS[@]}" | grep -qx "$d"; then
    echo "  PHANTOM in DOMAINS_INDEX.md (no sites/ folder): $d"
    DRIFT=$((DRIFT + 1))
  fi
done
[[ $DRIFT -eq 0 ]] && echo "  All clean." || true

DRIFT2=0
echo ""
echo "=== sites.yml active sites vs DOMAINS_INDEX.md ==="
for d in "${YML_DOMAINS[@]}"; do
  if ! printf '%s\n' "${INDEX_DOMAINS[@]}" | grep -qx "$d"; then
    echo "  In sites.yml but MISSING from DOMAINS_INDEX.md: $d"
    DRIFT2=$((DRIFT2 + 1))
  fi
done
[[ $DRIFT2 -eq 0 ]] && echo "  All clean." || true

TOTAL=$((DRIFT + DRIFT2))
echo ""
if [[ $TOTAL -eq 0 ]]; then
  echo "No drift detected."
else
  echo "$TOTAL drift issue(s) found." >&2
  exit 1
fi
