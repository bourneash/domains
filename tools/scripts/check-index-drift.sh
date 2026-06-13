#!/usr/bin/env bash
# check-index-drift.sh — verify sites/ dir, DOMAINS_INDEX.md, and sites.yml are in sync.
# Usage: bash tools/scripts/check-index-drift.sh
# Exits non-zero if any drift is detected.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAINS_INDEX="$REPO_ROOT/DOMAINS_INDEX.md"
SITES_YML="$REPO_ROOT/tools/site-tracker/sites.yml"

# Collect site dirs (basename of each sites/<domain>/)
mapfile -t SITE_DIRS < <(ls -1 "$REPO_ROOT/sites/" | sort)

# Collect domains in DOMAINS_INDEX.md (| domain | ... rows, strip whitespace and pipes)
mapfile -t INDEX_DOMAINS < <(grep -E '^\|\s+[a-z0-9]' "$DOMAINS_INDEX" \
  | awk -F'|' '{print $2}' | tr -d ' \t' | sort)

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
for d in "${INDEX_DOMAINS[@]}"; do
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
