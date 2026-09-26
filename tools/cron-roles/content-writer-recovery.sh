#!/usr/bin/env bash
# Inspect and safely recover content-writer commits retained after push/deploy failures.
set -euo pipefail
usage() { echo "usage: $0 <site> list|show <ref>|queue <ref>|branch <ref>" >&2; exit 2; }
SITE="${1:-}"; ACTION="${2:-}"
[[ -n "$SITE" && -n "$ACTION" ]] || usage
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; REPO="$ROOT/sites/$SITE"
[[ -d "$REPO/.git" || -f "$REPO/.git" ]] || { echo "site is not a git checkout: $SITE" >&2; exit 1; }
case "$ACTION" in
  list) git -C "$REPO" for-each-ref --format='%(refname:short) %(objectname:short) %(committerdate:iso8601) %(subject)' refs/heads/recovery/content-writer ;;
  show) REF="${3:-}"; [[ "$REF" == recovery/content-writer-* ]] || usage; git -C "$REPO" show --stat --oneline --decorate "$REF" ;;
  queue)
    REF="${3:-}"; [[ "$REF" == recovery/content-writer-* ]] || usage; git -C "$REPO" rev-parse --verify "$REF^{commit}" >/dev/null
    git -C "$REPO" fetch origin main --quiet
    git -C "$REPO" merge-base --is-ancestor "$REF" origin/main || { echo "recovery commit is not on origin/main; refusing to queue deployment" >&2; exit 1; }
    touch "$REPO/.deploy-needed"; echo "queued deploy for $SITE at $(git -C "$REPO" rev-parse --short "$REF")" ;;
  branch)
    REF="${3:-}"; [[ "$REF" == recovery/content-writer-* ]] || usage; SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"; NAME="recovery/content-writer-${SHA:0:12}"; git -C "$REPO" branch "$NAME" "$SHA" 2>/dev/null || true; echo "$NAME $SHA" ;;
  *) usage ;;
esac
