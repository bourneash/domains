#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-dd-containers-auth.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/root/tools/domain-developer/state"
mkdir -p "$TMP/home/.claude"
touch "$TMP/home/.claude/.credentials.json"

cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "ps" ]]; then
  printf '%s\n' dd-test
  exit 0
fi
if [[ "${1:-}" == "inspect" ]]; then
  if [[ "${FAKE_LEGACY:-0}" == "1" ]]; then
    printf '%s\n' "$FAKE_HOST_CRED"
  fi
  exit 0
fi
if [[ "${1:-}" == "exec" ]]; then
  # The worker has an independent credential, but the checker must not inspect
  # its contents or compare them to the host credential.
  exit 0
fi
exit 64
SH
chmod +x "$TMP/bin/docker"

PATH="$TMP/bin:$PATH" \
HOME="$TMP/home" \
FLEET_DOMAINS_ROOT="$TMP/root" \
DD_AUTH_HOST_CRED="$TMP/home/.claude/.credentials.json" \
DD_AUTH_CHECK_LOG="$TMP/auth.log" \
DD_AUTH_CHECK_LOCK="$TMP/auth.lock" \
DD_AUTH_ALERT_DIR="$TMP/alerts" \
"$SCRIPT"

grep -q 'dd-test: isolated Claude credential present' "$TMP/auth.log"

PATH="$TMP/bin:$PATH" \
HOME="$TMP/home" \
FAKE_LEGACY=1 \
FAKE_HOST_CRED="$TMP/home/.claude/.credentials.json" \
FLEET_DOMAINS_ROOT="$TMP/root" \
DD_AUTH_HOST_CRED="$TMP/home/.claude/.credentials.json" \
DD_AUTH_CHECK_LOG="$TMP/legacy.log" \
DD_AUTH_CHECK_LOCK="$TMP/legacy.lock" \
DD_AUTH_ALERT_DIR="$TMP/legacy-alerts" \
"$SCRIPT"

grep -q 'dd-test: SECURITY FAILURE' "$TMP/legacy.log"
test -f "$TMP/legacy-alerts/dd-test"
echo 'check-dd-containers-auth tests: PASS'
