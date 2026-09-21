#!/usr/bin/env bash
set -euo pipefail

# Invoke one site specialist without creating one permanently running model per
# domain. The manager receives the normal fleet brief plus a validated focus
# site, and reports back through the same audited proposal/message path.
if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "usage: $0 managed-site.example" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export EXECUTIVE_DOMAIN="$1"
export EXECUTIVE_PASSES="domain-manager"
export EXECUTIVE_ALLOW_QUEUE="${EXECUTIVE_ALLOW_QUEUE:-0}"
LOCK_SITE="$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-')"
export EXECUTIVE_LOCK_FILE="/tmp/domains-executive-domain-${LOCK_SITE}.lock"
export EXECUTIVE_CONTAINER_NAME="executive-domain-${LOCK_SITE}"
"$ROOT/tools/executive/run-sandbox.sh"
"$ROOT/tools/executive/checkin.sh"
