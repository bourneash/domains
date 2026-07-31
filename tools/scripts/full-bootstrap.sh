#!/usr/bin/env bash
# full-bootstrap.sh — one-shot Phase 1 for a domain
#
# Runs: bootstrap-domain.sh → first wrangler deploy → bind-worker-domain.sh
# in sequence. Designed for the multi-site batch workflow: kick this off
# as run_in_background:true for each domain in parallel.
#
# Usage:  bash tools/scripts/full-bootstrap.sh <domain.tld>
#
# Result: site live at https://<DOMAIN>/ (HTTP 200), worker created on CF,
# custom domain bound, email routing rules in place.
#
# Does NOT touch CF Workers Builds GitHub integration — that's a one-time
# manual step per worker after this script completes.
set -euo pipefail

# Parse flags. --no-email passes through to bootstrap-domain.sh to skip
# CF Email Routing setup (use when zone has Proton/Fastmail/etc. handling mail).
NO_EMAIL=0
ARGS=()
for arg in "$@"; do
  case "${arg}" in
    --no-email) NO_EMAIL=1 ;;
    *) ARGS+=("${arg}") ;;
  esac
done
set -- "${ARGS[@]}"

DOMAIN="${1:?Usage: $0 [--no-email] <domain.tld>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Disable Node inspector entirely — parallel runs collide on inspector port
# (9229 default, or whatever Vite/miniflare picks next). The bootstrap and
# deploy don't need the inspector; this just prevents the EADDRINUSE crash.
export NODE_OPTIONS="${NODE_OPTIONS:-} --inspect-port=0"

cd "${DOMAINS_ROOT}"

echo "==> [1/3] bootstrap-domain.sh ${DOMAIN}"
BOOTSTRAP_FLAGS=()
[ "${NO_EMAIL}" = "1" ] && BOOTSTRAP_FLAGS+=(--no-email)
bash "${SCRIPT_DIR}/bootstrap-domain.sh" "${BOOTSTRAP_FLAGS[@]}" "${DOMAIN}"

echo ""
echo "==> [2/3] First wrangler deploy ${DOMAIN}"
set -a
. "${DOMAINS_ROOT}/.env"
set +a
export PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:${PATH}"
npm --prefix "${DOMAINS_ROOT}/sites/${DOMAIN}/site" ci
npm --prefix "${DOMAINS_ROOT}/sites/${DOMAIN}/site" run deploy

echo ""
echo "==> [3/3] bind-worker-domain.sh ${DOMAIN}"
bash "${SCRIPT_DIR}/bind-worker-domain.sh" "${DOMAIN}"

echo ""
echo "==> full-bootstrap complete: https://${DOMAIN}/"
