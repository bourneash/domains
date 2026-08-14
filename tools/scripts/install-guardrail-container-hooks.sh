#!/bin/bash
# Wire the content-guardrails pre-commit check into every site's WORKER
# container. Containers can't use the host's core.hooksPath (it's an
# absolute host path that doesn't exist in-container) — see
# tools/content-guardrails/README.md for the full explanation. Fix: each
# worker entrypoint sets core.hooksPath as a --global git config (container-
# local ~/.gitconfig, never touches the repo's own tracked/shared .git/config)
# pointing at the .monorepo-tools mirror of tools/git-hooks, which every
# worker already mounts read-only.
#
# Idempotent — inserts one line right after the existing
# `git config --global --add safe.directory /work` anchor line, only if not
# already present. Safe to re-run. No image rebuild needed: entrypoint
# scripts are bind-mounted from the repo, live-effective on next container run.
#
# Usage: bash tools/scripts/install-guardrail-container-hooks.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SITES_DIR="$DOMAINS_ROOT/sites"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

ANCHOR='git config --global --add safe.directory /work'
INJECT='git config --global core.hooksPath /work/.monorepo-tools/git-hooks  # content-guardrails (installed by install-guardrail-container-hooks.sh)'

wired=0
already=0
no_anchor=0
none=0

for site_dir in "$SITES_DIR"/*/; do
  site_name=$(basename "$site_dir")
  ep="$site_dir/ops/docker/entrypoint-worker.sh"

  if [ ! -f "$ep" ]; then
    echo "  - $site_name (no entrypoint-worker.sh, skipped)"
    none=$((none + 1))
    continue
  fi

  if grep -qF "core.hooksPath" "$ep"; then
    echo "  = $site_name (already wired)"
    already=$((already + 1))
    continue
  fi

  if ! grep -qF "$ANCHOR" "$ep"; then
    echo "  ! $site_name (anchor line not found — needs manual wiring)"
    no_anchor=$((no_anchor + 1))
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ~ $site_name (would wire)"
    wired=$((wired + 1))
    continue
  fi

  # Insert INJECT on the line right after the anchor.
  awk -v anchor="$ANCHOR" -v inject="$INJECT" '
    { print }
    index($0, anchor) { print inject }
  ' "$ep" > "$ep.tmp" && mv "$ep.tmp" "$ep"
  chmod +x "$ep"
  echo "  ✓ $site_name (wired)"
  wired=$((wired + 1))
done

echo ""
echo "Done. Wired: $wired  Already: $already  No-anchor: $no_anchor  No-entrypoint: $none"
[ "$DRY_RUN" -eq 1 ] && echo "(dry run — no files changed)"
