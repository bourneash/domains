#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/ensure-fleet-cron.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="$TMP/bin"
SITES="$TMP/sites"
mkdir -p "$FAKE_BIN" "$SITES/healthy.test" "$SITES/recover.test"
printf 'services:\n  cron:\n    container_name: healthy-cron\n' > "$SITES/healthy.test/docker-compose.yml"
printf 'services:\n  cron:\n    container_name: recover-cron\n' > "$SITES/recover.test/docker-compose.yml"

cat > "$FAKE_BIN/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_CALLS"
case "${1:-}" in
  info) [[ "${FAKE_DOCKER_DOWN:-0}" != "1" ]] ;;
  inspect)
    name="${*: -1}"
    if [[ "$name" == "healthy-cron" ]]; then
      printf 'running\n'
    elif [[ -f "$FAKE_RECOVERED" && "${FAKE_STAY_DOWN:-0}" != "1" ]]; then
      printf 'running\n'
    else
      printf 'exited\n'
    fi
    ;;
  compose)
    [[ "$*" == "compose up -d --no-deps cron" ]]
    : > "$FAKE_RECOVERED"
    ;;
  *) exit 64 ;;
esac
SH
chmod +x "$FAKE_BIN/docker"

run_script() {
  PATH="$FAKE_BIN:$PATH" \
  FAKE_DOCKER_CALLS="$TMP/docker.calls" \
  FAKE_RECOVERED="$TMP/recovered" \
  FLEET_SITES_DIR="$SITES" \
  FLEET_CRON_LOG="$TMP/ensure.log" \
  FLEET_CRON_LOCK="$TMP/ensure.lock" \
  FLEET_CRON_ALERT_DIR="$TMP/alerts" \
  FLEET_CRON_VERIFY_DELAY=0 \
  FLEET_CRON_NOTIFY=0 \
  "$SCRIPT"
}

run_script
grep -q '^compose up -d --no-deps cron$' "$TMP/docker.calls"
grep -q "recovered 'recover-cron' successfully" "$TMP/ensure.log"
if grep -q 'healthy.test.*bringing up' "$TMP/ensure.log"; then
  echo "healthy scheduler was needlessly restarted" >&2
  exit 1
fi

: > "$TMP/docker.calls"
rm -f "$TMP/recovered"
set +e
FAKE_STAY_DOWN=1 run_script
status=$?
set -e
[[ "$status" -eq 1 ]]
grep -q "returned success but 'recover-cron' status=exited" "$TMP/ensure.log"

: > "$TMP/docker.calls"
set +e
FAKE_DOCKER_DOWN=1 run_script
status=$?
set -e
[[ "$status" -eq 1 ]]
if grep -q '^compose ' "$TMP/docker.calls"; then
  echo "compose was called while Docker daemon preflight was down" >&2
  exit 1
fi

echo "ensure-fleet-cron tests: PASS"
