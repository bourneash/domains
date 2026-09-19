#!/usr/bin/env bash
# Worker-side half of run-image-repair.sh. Generates only a queue item's
# missing/invalid art (the site generator is idempotent), validates the result,
# then commits and pushes exactly the draft plus its asset directory.

set -euo pipefail

REPO_ROOT="${1:?usage: repair-images.sh <repo-root> <status> <file> <required-csv>}"
STATUS_NAME="${2:?missing status}"
FILE_NAME="${3:?missing file}"
REQUIRED_CSV="${4:?missing required fields}"
cd "$REPO_ROOT"

mkdir -p ops/.locks
exec 8>ops/.locks/guide-images.lock
if ! flock -n 8; then
  exit 75
fi

TOOLS_ROOT="$REPO_ROOT/.monorepo-tools"
[[ -d "$TOOLS_ROOT/guide-queue" ]] || TOOLS_ROOT="$REPO_ROOT/../../tools"
GQ_CLI="$TOOLS_ROOT/guide-queue/lib/cli.py"
export GUIDE_QUEUE_LIB_DIR="$TOOLS_ROOT/guide-queue/lib"
export MEDIA_GEN_CLIENT_DIR="$TOOLS_ROOT/media-gen/client"
IFS=, read -r -a REQUIRED <<<"$REQUIRED_CSV"

set +e
python3 ops/scripts/generate-guide-images.py "$REPO_ROOT" "$STATUS_NAME" "$FILE_NAME" \
  --backend comfyui --fallback-backend nanobanana
GEN_STATUS=$?
set -e
if [[ $GEN_STATUS -ne 0 ]]; then
  exit "$GEN_STATUS"
fi

CHECK=$(python3 "$GQ_CLI" check-images "$REPO_ROOT" "$STATUS_NAME" "$FILE_NAME" "${REQUIRED[@]}")
python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin)["ok"] else 1)' <<<"$CHECK" || {
  echo "[guide-image-repair] generator returned success but required-art validation still fails: $CHECK" >&2
  exit 1
}
QUEUE_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["queue_id"])' <<<"$CHECK")

git add -- "ops/guide-queue/$STATUS_NAME/$FILE_NAME" "ops/guide-queue/drafted-assets/$QUEUE_ID"
if ! git diff --cached --quiet; then
  git commit -m "guide-queue: repair images for $QUEUE_ID" -q
fi

source "$TOOLS_ROOT/scripts/git-push-retry.sh" 2>/dev/null || true
if command -v git_push_retry >/dev/null 2>&1; then
  git_push_retry
else
  git push origin HEAD:main
fi

echo "[guide-image-repair] repaired and pushed $STATUS_NAME/$FILE_NAME"
