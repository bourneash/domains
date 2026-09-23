#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SITE_SCRIPT="$ROOT/sites/saveusfarms.com/ops/scripts/run-engineer.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

bash -n "$SITE_SCRIPT"

# Extract the pure alert-policy function; the full worker requires network and
# Claude credentials, while this covers the noisy decision boundary directly.
eval "$(sed -n '/^pending_commit_alert_due()/,/^}/p' "$SITE_SCRIPT")"
UNPUSHED_COMMIT_NOTIFY_AGE_SECS=1200
UNPUSHED_COMMIT_ALERT_COOLDOWN_SECS=21600
STATE="$TMP_DIR/state"

if pending_commit_alert_due "$STATE" abc 1000 1199; then
  echo "FAIL: fresh commit should not alert" >&2; exit 1
fi
if ! pending_commit_alert_due "$STATE" abc 1000 1200; then
  echo "FAIL: stale unalerted commit should alert" >&2; exit 1
fi
printf 'abc\n1000\n' > "$STATE"
if pending_commit_alert_due "$STATE" abc 2000 7200; then
  echo "FAIL: recently alerted commit should be rate-limited" >&2; exit 1
fi
if ! pending_commit_alert_due "$STATE" def 2000 7200; then
  echo "FAIL: new pending commit should alert" >&2; exit 1
fi

echo "PASS: engineer noise hardening"
