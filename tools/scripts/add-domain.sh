#!/usr/bin/env bash
# add-domain.sh — operator entrypoint for adding a domain
#
# Default behavior matches the normal fleet workflow:
#   1. bootstrap-domain.sh
#   2. manual/normal follow-up deploy from the checked-out site
#   3. bind-worker-domain.sh after first successful deploy
#
# Use --full for the one-shot batch path:
#   bootstrap-domain.sh -> first deploy -> bind-worker-domain.sh
set -euo pipefail

MODE="bootstrap"
ARGS=()
for arg in "$@"; do
  case "${arg}" in
    --full) MODE="full" ;;
    *) ARGS+=("${arg}") ;;
  esac
done
set -- "${ARGS[@]}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${MODE}" in
  bootstrap)
    exec bash "${SCRIPT_DIR}/bootstrap-domain.sh" "$@"
    ;;
  full)
    exec bash "${SCRIPT_DIR}/full-bootstrap.sh" "$@"
    ;;
esac
