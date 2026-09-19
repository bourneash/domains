#!/usr/bin/env bash
# Cron-side, zero-AI repair gate for guide artwork. It scans the site's
# durable queue, respects a persisted exponential backoff, and only spins the
# full worker image when a draft/ready item actually needs art.

set -euo pipefail

REPO_ROOT="$(pwd)"
cd "$REPO_ROOT"

TOOLS_ROOT="$REPO_ROOT/.monorepo-tools"
[[ -d "$TOOLS_ROOT/guide-queue" ]] || TOOLS_ROOT="$REPO_ROOT/../../tools"
GQ_CLI="$TOOLS_ROOT/guide-queue/lib/cli.py"
WORKER_SCRIPT="/work/.monorepo-tools/guide-queue/bin/repair-images.sh"
STATE_FILE="$REPO_ROOT/ops/logs/guide-image-repair-state.json"
SITE="${SITE_NAME:-$(basename "$REPO_ROOT")}"

REQUIRED_JSON=$(python3 - <<'PY'
import json
from pathlib import Path
import yaml

path = Path("ops/tracked.yaml")
try:
    data = yaml.safe_load(path.read_text()) if path.is_file() else {}
except Exception:
    data = {}
value = ((data or {}).get("manual") or {}).get("guide_required_images")
if not isinstance(value, list) or not value:
    value = ["hero_image", "card_image"]
print(json.dumps([str(v) for v in value]))
PY
)
mapfile -t REQUIRED < <(python3 -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "$REQUIRED_JSON")

CANDIDATE=$(python3 "$GQ_CLI" oldest-missing-images "$REPO_ROOT" "${REQUIRED[@]}")
if [[ "$CANDIDATE" == "null" ]]; then
  if [[ -f "$STATE_FILE" ]]; then
    # The generator may have finished but the later validation/commit/push
    # step may have failed. Resume that exact item from durable state; file
    # existence alone is not proof the repair transaction completed.
    CANDIDATE=$(python3 - "$STATE_FILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(json.dumps({
    "status": d["status"],
    "file": d["file"],
    "queue_id": d["queue_id"],
    "title": d.get("title", d["file"]),
    "missing": [{"field": field, "reason": "resume-incomplete-transaction"}
                for field in d.get("missing", [])],
}))
PY
)
  else
    echo "[guide-image-repair] no missing required artwork"
    exit 0
  fi
fi

readarray -t FIELDS < <(python3 -c '
import json,sys
d=json.load(sys.stdin)
print(d["status"])
print(d["file"])
print(d["queue_id"])
print(d.get("title", d["file"]))
print(",".join(x["field"] for x in d["missing"]))
' <<<"$CANDIDATE")
STATUS_NAME="${FIELDS[0]}"
FILE_NAME="${FIELDS[1]}"
QUEUE_ID="${FIELDS[2]}"
TITLE="${FIELDS[3]}"
MISSING="${FIELDS[4]}"

NOW=$(date +%s)
ATTEMPTS=0
NEXT_AT=0
STATE_QID=""
if [[ -f "$STATE_FILE" ]]; then
  readarray -t PRIOR < <(python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print(d.get("queue_id", ""))
print(int(d.get("attempts", 0)))
print(int(d.get("next_at", 0)))
' "$STATE_FILE")
  STATE_QID="${PRIOR[0]}"
  ATTEMPTS="${PRIOR[1]}"
  NEXT_AT="${PRIOR[2]}"
fi
if [[ "$STATE_QID" != "$QUEUE_ID" ]]; then
  ATTEMPTS=0
  NEXT_AT=0
fi
if (( NOW < NEXT_AT )); then
  echo "[guide-image-repair] backoff active for $QUEUE_ID; next attempt at $(date -d "@$NEXT_AT" --iso-8601=seconds)"
  exit 0
fi

echo "[guide-image-repair] repairing $STATUS_NAME/$FILE_NAME missing=$MISSING"
set +e
timeout -k 30 1200 docker compose run --rm --entrypoint bash worker \
  "$WORKER_SCRIPT" /work "$STATUS_NAME" "$FILE_NAME" "$(IFS=,; echo "${REQUIRED[*]}")"
RESULT=$?
set -e

if [[ $RESULT -eq 75 ]]; then
  echo "[guide-image-repair] another writer/repair owns the guide-image lock; deferred"
  exit 0
fi

mkdir -p "$(dirname "$STATE_FILE")"
if [[ $RESULT -eq 0 ]]; then
  rm -f "$STATE_FILE"
  echo "GUIDE_IMAGE_RECOVERY site=$SITE queue_id=$QUEUE_ID result=required-art-validated"
  exit 0
fi

ATTEMPTS=$((ATTEMPTS + 1))
DELAY=$((900 * (1 << (ATTEMPTS - 1))))
(( DELAY > 21600 )) && DELAY=21600
NEXT_AT=$((NOW + DELAY))
TMP_STATE="${STATE_FILE}.$$"
python3 - "$TMP_STATE" "$QUEUE_ID" "$STATUS_NAME" "$FILE_NAME" "$TITLE" "$MISSING" "$ATTEMPTS" "$NEXT_AT" "$RESULT" <<'PY'
import json, sys
from pathlib import Path

path, qid, status, filename, title, missing, attempts, next_at, result = sys.argv[1:]
Path(path).write_text(json.dumps({
    "queue_id": qid,
    "status": status,
    "file": filename,
    "title": title,
    "missing": missing.split(",") if missing else [],
    "attempts": int(attempts),
    "next_at": int(next_at),
    "last_exit": int(result),
}, indent=2) + "\n")
PY
mv "$TMP_STATE" "$STATE_FILE"

if (( ATTEMPTS == 1 )); then
  echo "CRIT GUIDE_IMAGE_FAILURE site=$SITE queue_id=$QUEUE_ID missing=$MISSING attempt=$ATTEMPTS next_at=$NEXT_AT exit=$RESULT"
else
  echo "WARN GUIDE_IMAGE_RETRY_PENDING site=$SITE queue_id=$QUEUE_ID missing=$MISSING attempt=$ATTEMPTS next_at=$NEXT_AT exit=$RESULT"
fi
exit 0
