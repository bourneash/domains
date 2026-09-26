#!/usr/bin/env bash
set -euo pipefail

# The executive model is never launched directly on the host. The model
# container receives only a generated brief and an output directory.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${EXECUTIVE_IMAGE:-domains-executive-runner:latest}"
MODE="${EXECUTIVE_MODE:---apply}"
IMAGE_SOURCE_LABEL="com.bourneash.executive.source-sha"
# The manual runner lives in fleet-dashboard while scheduled runs live in
# fleet-cron. A /tmp lock is container-local and cannot serialize those two
# callers, so the default lock must live on the shared project bind mount.
LOCK_FILE="${EXECUTIVE_LOCK_FILE:-$ROOT/tools/executive/data/executive.lock}"
# An explicit name is used by per-site dispatch so its site lock can make the
# identity easy to audit. The fleet-wide default gets a process-specific
# suffix so an orphaned Docker object cannot collide with the next tick after a
# host or scheduler interruption.
CONTAINER_NAME="${EXECUTIVE_CONTAINER_NAME:-executive-ceo-cto-${BASHPID}}"
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
    "$ROOT/tools/fleet-dashboard/server/executive-data.js" \
    "$ROOT/tools/fleet-dashboard/server/workflow-engine.js"; do
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

container_args=(run --rm --name "$CONTAINER_NAME" --entrypoint /usr/bin/env \
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
# ChatGPT OAuth tokens may need to refresh during a long-lived cron container,
# so the isolated runner must be able to update this one auth file. No other
# host configuration or credential path is mounted writable.
CLAUDE_CREDENTIALS_FILE="${CLAUDE_CREDENTIALS_FILE:-${HOME:-/home/jesse}/.claude/.credentials.json}"
CLAUDE_CONFIG_FILE="${CLAUDE_CONFIG_FILE:-${HOME:-/home/jesse}/.claude.json}"
[[ "$CLAUDE_CREDENTIALS_FILE" == "${HOME:-/home/jesse}/.claude/.credentials.json" ]] || { echo "credential path is restricted" >&2; exit 1; }
[[ "$CLAUDE_CONFIG_FILE" == "${HOME:-/home/jesse}/.claude.json" ]] || { echo "config path is restricted" >&2; exit 1; }
if [[ -f "$CLAUDE_CREDENTIALS_FILE" ]]; then
  container_args+=( -v "$CLAUDE_CREDENTIALS_FILE:/home/dev/.claude/.credentials.json:ro" )
fi
if [[ -f "$CLAUDE_CONFIG_FILE" ]]; then
  container_args+=( -v "$CLAUDE_CONFIG_FILE:/home/dev/.claude.json:ro" )
fi

# Codex Pro authentication is the only Codex host material mounted. Do not
# mount the host ~/.codex directory: it contains unrelated sessions, MCP
# configuration, and project trust entries.
# When this script is launched from fleet-dashboard, HOME points at the
# dashboard container while the nested Docker daemon needs the host path.
# The compose file supplies that path explicitly; using it avoids silently
# starting a manual run without the mounted ChatGPT credential.
CODEX_AUTH_FILE="${CODEX_AUTH_FILE:-${FD_CODEX_AUTH_FILE_HOST:-${HOME:-/home/jesse}/.codex/auth.json}}"
CODEX_AUTH_ALLOWED="${FD_CODEX_AUTH_FILE_HOST:-${HOME:-/home/jesse}/.codex/auth.json}"
[[ "$CODEX_AUTH_FILE" == "$CODEX_AUTH_ALLOWED" ]] || { echo "Codex auth path is restricted" >&2; exit 1; }
# fleet-dashboard sees the credential at FD_CODEX_AUTH_FILE, while the
# Docker daemon resolves the bind source on the host via CODEX_AUTH_FILE.
CODEX_AUTH_VISIBLE="${FD_CODEX_AUTH_FILE:-$CODEX_AUTH_FILE}"
if [[ -f "$CODEX_AUTH_VISIBLE" ]]; then
  container_args+=( -v "$CODEX_AUTH_FILE:/home/dev/.codex/auth.json:rw" )
fi

container_args+=( "$IMAGE" )

write_provider_failure() {
  local message="$1"
  node - "$RUN_DIR/output/failure.json" "$message" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const error = process.argv[3];
fs.writeFileSync(
  file,
  JSON.stringify({ error, passes_completed: [], usage: { calls: 0, estimated_total_tokens: 0 } }, null, 2),
  { mode: 0o600 }
);
NODE
}

# Validate the same OAuth credential from inside the same image/mount boundary
# used for the real model run. `codex login status` is local and non-billing: it
# confirms that the isolated process can discover the ChatGPT login without
# exposing or modifying the host credential.
if [[ "$EXECUTIVE_PROVIDER" == "chatgpt" ]]; then
  set +e
  PREFLIGHT_OUTPUT=$(timeout -s TERM -k 5 30s docker "${container_args[@]}" codex login status 2>&1)
  PREFLIGHT_STATUS=$?
  set -e
  # The command's exit status is authoritative. The human-readable success
  # line varies between Codex releases and may include terminal color codes,
  # so matching that text made valid logins fail with exit 78.
  if [[ "$PREFLIGHT_STATUS" -ne 0 ]]; then
    PREFLIGHT_DETAIL="${PREFLIGHT_OUTPUT//$'\n'/ }"
    write_provider_failure "executive_auth_preflight_failed: Codex ChatGPT login was not available inside the isolated runner (status ${PREFLIGHT_STATUS}${PREFLIGHT_DETAIL:+; ${PREFLIGHT_DETAIL:0:240}})"
    MODEL_STATUS=78
  fi
fi

run_model() {
  local log_file="$RUN_DIR/model.log"
  : > "$log_file"
  timeout -s TERM -k 30 "${EXECUTIVE_CONTAINER_TIMEOUT:-20m}" docker \
    "${container_args[@]}" node /app/tools/executive/model-runner.js >"$log_file" 2>&1
  local status=$?
  cat "$log_file"
  return "$status"
}

if [[ "${MODEL_STATUS:-0}" -eq 0 ]]; then
  # Use the same bounded command for the actual run. A single retry is allowed
  # only for a provider-auth failure before any executive pass completed; this
  # handles transient bearer discovery races without duplicating a partial,
  # potentially expensive leadership run.
  set +e
  run_model
  MODEL_STATUS=$?
  set -e
  if [[ "$MODEL_STATUS" -ne 0 && -s "$RUN_DIR/output/failure.json" ]] && \
    grep -Eiq '401[[:space:]]+Unauthorized|Missing bearer|authentication' "$RUN_DIR/model.log"; then
    PASSES_COMPLETED="$(node - "$RUN_DIR/output/failure.json" <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(String(Array.isArray(value.passes_completed) ? value.passes_completed.length : 1));
} catch {
  process.stdout.write('1');
}
NODE
)"
    if [[ "$PASSES_COMPLETED" == "0" ]]; then
      echo "executive provider authentication failed before the first pass; retrying once" >&2
      sleep 2
      set +e
      run_model
      MODEL_STATUS=$?
      set -e
    fi
  fi
fi

# Preserve the model's bounded, non-secret usage estimate outside the transient
# exchange directory. This gives the dashboard/auditor a per-cycle record even
# though the plan and prompts are removed when the run exits.
if [[ -s "$RUN_DIR/output/usage.json" ]]; then
  USAGE_DIR="$ROOT/tools/executive/data/usage"
  mkdir -m 700 -p "$USAGE_DIR"
  cp "$RUN_DIR/output/usage.json" "$USAGE_DIR/usage-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
fi

if [[ "$MODEL_STATUS" -ne 0 ]]; then
  FAILURE_DIR="$ROOT/tools/executive/data/failures"
  mkdir -m 700 -p "$FAILURE_DIR"
  if [[ -s "$RUN_DIR/output/failure.json" ]]; then
    cp "$RUN_DIR/output/failure.json" "$FAILURE_DIR/failure-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  fi
  # The trusted host records a failed tick even when the isolated provider
  # exits before it can produce a plan. This preserves the historical failure
  # without allowing partial or malformed model output into applyPlan().
  node - "$ROOT" "$MODEL_STATUS" "$RUN_DIR/output/failure.json" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2];
const exitCode = Number(process.argv[3]);
const failureFile = process.argv[4];
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const store = eventstore.open(root);
try {
  let details = { error: `isolated executive model exited with status ${exitCode}` };
  try {
    if (fs.existsSync(failureFile)) details = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
  } catch {
    /* Keep the exit-code audit when the provider did not write diagnostics. */
  }
  const audit = executive.action(store, {
    actor: 'system',
    action_type: 'tick',
    summary: 'Executive isolated model run failed before plan application',
    target_type: 'executive-model-run',
    target_id: `sandbox-${process.pid}`,
  });
  executive.finishAction(store, audit.action_id, {
    status: 'failed',
    error: String(details.error || `isolated executive model exited with status ${exitCode}`),
    result: {
      exit_code: exitCode,
      passes_completed: Array.isArray(details.passes_completed) ? details.passes_completed.length : 0,
      estimated_total_tokens: Number(details.usage?.estimated_total_tokens || 0),
      failure_artifact: fs.existsSync(failureFile) ? failureFile : null,
    },
  });
} finally {
  store.close();
}
NODE
  exit "$MODEL_STATUS"
fi

[[ -s "$RUN_DIR/output/plan.json" ]] || { echo "executive model produced no plan" >&2; exit 1; }
node "$ROOT/tools/executive/runner.js" --apply-plan-file "$RUN_DIR/output/plan.json" $MODE
