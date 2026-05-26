#!/usr/bin/env bash
# add-deploy-marker.sh — add x-deploy-test meta tag, commit, push to trigger Workers Builds
#
# Usage:  bash tools/scripts/add-deploy-marker.sh <domain.tld>
#
# Inserts a `<meta name="x-deploy-test" content="cf-builds-verify" />` line
# into the site's index.astro right after the existing `robots` meta. The
# marker is what poll-worker-deploy.sh / check-live-marker.sh look for.
#
# Push triggers CF Workers Builds → new worker version within ~30-60s.
# Pair with strip-deploy-marker.sh after verification to clean up.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain.tld>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

INDEX="${DOMAINS_ROOT}/sites/${DOMAIN}/site/src/pages/index.astro"
[ -f "${INDEX}" ] || { echo "ERROR: ${INDEX} not found" >&2; exit 1; }

sed -i 's|<meta name="robots" content="noindex" />|<meta name="robots" content="noindex" />\n    <meta name="x-deploy-test" content="cf-builds-verify" />|' "${INDEX}"

cd "${DOMAINS_ROOT}/sites/${DOMAIN}"
git add -A
git -c commit.gpgsign=false commit -q -m "test: verify CF Workers Builds GitHub integration"
git push -q origin main

echo "${DOMAIN}: marker pushed ($(git rev-parse --short HEAD))"
