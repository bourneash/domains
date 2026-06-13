#!/bin/bash
# Wire the shared pre-commit hook into every site submodule.
# Safe to re-run — just updates core.hooksPath, doesn't touch code.
#
# Usage: bash tools/scripts/install-git-hooks.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOKS_DIR="$DOMAINS_ROOT/tools/git-hooks"
SITES_DIR="$DOMAINS_ROOT/sites"

if [ ! -f "$HOOKS_DIR/pre-commit" ]; then
  echo "ERROR: $HOOKS_DIR/pre-commit not found"
  exit 1
fi

chmod +x "$HOOKS_DIR/pre-commit"

installed=0
skipped=0

for site_dir in "$SITES_DIR"/*/; do
  site_name=$(basename "$site_dir")

  # Submodules have a .git file (pointer) or .git dir
  if [ -e "$site_dir/.git" ]; then
    git -C "$site_dir" config core.hooksPath "$HOOKS_DIR"
    echo "  ✓ $site_name"
    installed=$((installed + 1))
  else
    echo "  - $site_name (no .git, skipped)"
    skipped=$((skipped + 1))
  fi
done

echo ""
echo "Done. Hooked: $installed  Skipped: $skipped"
echo "Hook path: $HOOKS_DIR"
