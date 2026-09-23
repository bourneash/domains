#!/usr/bin/env bash
set -euo pipefail

# The executive model is never launched directly on the host. The model
# container receives only a generated brief and an output directory.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${EXECUTIVE_IMAGE:-domains-executive-runner:latest}"
MODE="${EXECUTIVE_MODE:---apply}"
IMAGE_SOURCE_LABEL="com.bourneash.executive.source-sha"
LOCK_FILE="${EXECUTIVE_LOCK_FILE:-/tmp/domains-executive.lock}"
CONTAINER_NAME="${EXECUTIVE_CONTAINER_NAME:-executive-ceo-cto}"
export EXECUTIVE_PROVIDER="${EXECUTIVE_PROVIDER:-chatgpt}"
export EXECUTIVE_MODEL="${EXECUTIVE_MODEL:-gpt-5.6-luna}"
export EXECUTIVE_PASSES="${EXECUTIVE_PASSES:-adaptive}"
[[ "${EXECUTIVE_ALLOW_QUEUE:-0}" == "1" ]] && MODE="$MODE --allow-queue"

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "executive tick already running" >&2; exit 75; }

# The model image is intentionally isolated from the checkout, so it must be
# rebuilt when its copied source changes. A plain "image exists" check leaves
# the production model running stale validation and policy code indefinitely.
SOURCE_DIGEST="$({
  find "$ROOT/tools/executive" -type f ! -path '*/data/*' ! -path '*/logs/*' -print | sort | while IFS= read -r file; do sha256sum "$file"; done
  for file in \
    "$ROOT/tools/fleet-dashboard/server/eventstore.js" \
    "$ROOT/tools/fleet-dashboard/server/executive.js" \
    "$ROOT/tools/fleet-dashboard/server/changequeue.js" \
    "$ROOT/tools/fleet-dashboard/server/task-routing.js" \
    "$ROOT/tools/fleet-dashboard/server/executive-scorecard.js" \
    "$ROOT/tools/fleet-dashboard/server/executive-snapshot.js" \
    "$ROOT/tools/fleet-dashboard/server/executive-data.js"; do
    sha256sum "$file"
  done
} | sha256sum | awk '{print $1}')"
CURRENT_DIGEST="$(docker image inspect --format "{{index .Config.Labels \"$IMAGE_SOURCE_LABEL\"}}" "$IMAGE" 2>/dev/null || true)"
if [[ "$CURRENT_DIGEST" != "$SOURCE_DIGEST" ]]; then
  echo "building $IMAGE from current executive source ($SOURCE_DIGEST)" >&2
  docker build --label "$IMAGE_SOURCE_LABEL=$SOURCE_DIGEST" \
    -f "$ROOT/tools/executive/Dockerfile" -t "$IMAGE" "$ROOT"
fi

# fleet-cron launches this through the Docker socket. A /tmp path inside the
# fleet-cron container is not visible to the nested model container, so keep
# this private transient exchange on the project bind mount instead. Only the
# generated brief and model output are mounted into the model; the checkout is
# still not mounted.
RUN_DIR="$(mktemp -d "$ROOT/tools/executive/data/.run.XXXXXX")"
mkdir -m 700 "$RUN_DIR/input" "$RUN_DIR/output"
trap 'rm -rf "$RUN_DIR"' EXIT

# Brief generation and plan application happen in the trusted control plane.
node "$ROOT/tools/executive/runner.js" --brief-only > "$RUN_DIR/input/brief.json"

args=(run --rm --name "$CONTAINER_NAME" --entrypoint /usr/bin/env \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=256 --memory=2g --cpus=2 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /home/dev/.codex:rw,noexec,nosuid,size=32m \
  --network "${EXECUTIVE_NETWORK:-bridge}" \
  -v "$RUN_DIR/input:/input:ro" -v "$RUN_DIR/output:/output:rw" \
  -e HOME=/home/dev -e CODEX_HOME=/home/dev/.codex \
  -e EXECUTIVE_PROVIDER -e EXECUTIVE_MODEL \
  -e EXECUTIVE_TIMEOUT_MS -e EXECUTIVE_PASS_TIMEOUT_MS -e EXECUTIVE_PASSES -e DISABLE_AUTOUPDATER=1 \
)

# Authentication is the only host material allowed besides the project mount.
# It is read-only and can be omitted when the provider uses an API-key env var.
CLAUDE_CREDENTIALS_FILE="${CLAUDE_CREDENTIALS_FILE:-${HOME:-/home/jesse}/.claude/.credentials.json}"
CLAUDE_CONFIG_FILE="${CLAUDE_CONFIG_FILE:-${HOME:-/home/jesse}/.claude.json}"
[[ "$CLAUDE_CREDENTIALS_FILE" == "${HOME:-/home/jesse}/.claude/.credentials.json" ]] || { echo "credential path is restricted" >&2; exit 1; }
[[ "$CLAUDE_CONFIG_FILE" == "${HOME:-/home/jesse}/.claude.json" ]] || { echo "config path is restricted" >&2; exit 1; }
if [[ -f "$CLAUDE_CREDENTIALS_FILE" ]]; then
  args+=( -v "$CLAUDE_CREDENTIALS_FILE:/home/dev/.claude/.credentials.json:ro" )
fi
if [[ -f "$CLAUDE_CONFIG_FILE" ]]; then
  args+=( -v "$CLAUDE_CONFIG_FILE:/home/dev/.claude.json:ro" )
fi

# Codex Pro authentication is the only Codex host material mounted. Do not
# mount the host ~/.codex directory: it contains unrelated sessions, MCP
# configuration, and project trust entries.
CODEX_AUTH_FILE="${CODEX_AUTH_FILE:-${HOME:-/home/jesse}/.codex/auth.json}"
[[ "$CODEX_AUTH_FILE" == "${HOME:-/home/jesse}/.codex/auth.json" ]] || { echo "Codex auth path is restricted" >&2; exit 1; }
if [[ -f "$CODEX_AUTH_FILE" ]]; then
  args+=( -v "$CODEX_AUTH_FILE:/home/dev/.codex/auth.json:ro" )
fi

args+=( "$IMAGE" node /app/tools/executive/model-runner.js )
# Use the BusyBox-compatible timeout flags available in fleet-cron as well as
# GNU coreutils. The long GNU spellings make the dispatcher fail before the
# isolated model container starts on the production scheduler image.
timeout -s TERM -k 30 "${EXECUTIVE_CONTAINER_TIMEOUT:-20m}" docker "${args[@]}"

# Preserve the model's bounded, non-secret usage estimate outside the transient
# exchange directory. This gives the dashboard/auditor a per-cycle record even
# though the plan and prompts are removed when the run exits.
if [[ -s "$RUN_DIR/output/usage.json" ]]; then
  USAGE_DIR="$ROOT/tools/executive/data/usage"
  mkdir -m 700 -p "$USAGE_DIR"
  cp "$RUN_DIR/output/usage.json" "$USAGE_DIR/usage-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
fi

[[ -s "$RUN_DIR/output/plan.json" ]] || { echo "executive model produced no plan" >&2; exit 1; }
node "$ROOT/tools/executive/runner.js" --apply-plan-file "$RUN_DIR/output/plan.json" $MODE
