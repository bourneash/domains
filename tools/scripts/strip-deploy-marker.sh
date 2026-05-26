#!/usr/bin/env bash
# strip-deploy-marker.sh — remove x-deploy-test meta tag, commit, push cleanup
#
# Usage:  bash tools/scripts/strip-deploy-marker.sh <domain.tld>
#
# Counterpart of add-deploy-marker.sh. Removes the verification meta tag
# from index.astro and pushes the cleanup commit. Workers Builds will
# auto-deploy the cleaned-up site within ~30-60s.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain.tld>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

INDEX="${DOMAINS_ROOT}/sites/${DOMAIN}/site/src/pages/index.astro"
[ -f "${INDEX}" ] || { echo "ERROR: ${INDEX} not found" >&2; exit 1; }

sed -i '/<meta name="x-deploy-test"/d' "${INDEX}"

cd "${DOMAINS_ROOT}/sites/${DOMAIN}"
git add -A
git -c commit.gpgsign=false commit -q -m "remove test marker — CF Workers Builds verified"
git push -q origin main

echo "${DOMAIN}: cleanup pushed ($(git rev-parse --short HEAD))"
