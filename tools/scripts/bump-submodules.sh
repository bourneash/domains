#!/usr/bin/env bash
# bump-submodules.sh — git add + commit + push one or more submodule pointers in parent repo
#
# Usage:  bash tools/scripts/bump-submodules.sh "<commit message>" <domain1> [domain2] ...
#
# Stages the submodule pointer changes for each given <domain> (i.e.
# sites/<domain>), creates a single signed-off commit on the parent repo,
# and pushes to origin/main. Designed for the end of a batch run.
set -euo pipefail

MESSAGE="${1:?Usage: $0 <commit-message> <domain1> [domain2] ...}"
shift
[ "$#" -gt 0 ] || { echo "ERROR: provide at least one domain" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${DOMAINS_ROOT}"

PATHS=()
for D in "$@"; do
  PATHS+=("sites/${D}")
done

git add "${PATHS[@]}"
git -c commit.gpgsign=false commit -q -m "${MESSAGE}"
git push -q origin main

echo "Bumped: ${PATHS[*]}"
echo "Parent commit: $(git rev-parse --short HEAD)"
