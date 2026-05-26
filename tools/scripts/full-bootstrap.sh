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

DOMAIN="${1:?Usage: $0 <domain.tld>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${DOMAINS_ROOT}"

echo "==> [1/3] bootstrap-domain.sh ${DOMAIN}"
bash "${SCRIPT_DIR}/bootstrap-domain.sh" "${DOMAIN}"

echo ""
echo "==> [2/3] First wrangler deploy ${DOMAIN}"
set -a
. "${DOMAINS_ROOT}/.env"
set +a
export PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:${PATH}"
npm --prefix "${DOMAINS_ROOT}/sites/${DOMAIN}/site" install
npm --prefix "${DOMAINS_ROOT}/sites/${DOMAIN}/site" run deploy

echo ""
echo "==> [3/3] bind-worker-domain.sh ${DOMAIN}"
bash "${SCRIPT_DIR}/bind-worker-domain.sh" "${DOMAIN}"

echo ""
echo "==> full-bootstrap complete: https://${DOMAIN}/"
