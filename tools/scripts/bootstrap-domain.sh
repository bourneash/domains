#!/usr/bin/env bash
# bootstrap-domain.sh — scaffold a new domain project
#
# Usage: ./bootstrap-domain.sh <domain.tld>
#
# What it does:
#   1. Creates Astro coming-soon scaffold in /tmp, installs, builds
#   2. Pushes to private GitHub repo at bourneash/<domain>
#   3. Registers the repo as a git submodule under sites/<domain>
#   4. Sets up CF email routing (contact@, takedown@, catch-all)
#
# After this: connect CF Workers to GitHub via the CF dashboard,
# then run: bind-worker-domain.sh <domain>
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain.tld>}"
WORKER_NAME="${DOMAIN//./-}"
SITE_NAME="${WORKER_NAME}-site"
GITHUB_REPO="bourneash/${DOMAIN}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

set -a; . "${DOMAINS_ROOT}/.env"; set +a
export PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:${PATH}"

echo ""
echo "=== bootstrap-domain.sh: ${DOMAIN} ==="
echo "  Worker name : ${WORKER_NAME}"
echo "  GitHub repo : ${GITHUB_REPO}"
echo ""

# ── 1. Scaffold in /tmp ────────────────────────────────────────────────────
TMPSCAFFOLD="/tmp/bootstrap-${DOMAIN}"
rm -rf "${TMPSCAFFOLD}"
mkdir -p "${TMPSCAFFOLD}/site/src/pages"
mkdir -p "${TMPSCAFFOLD}/site/public"
mkdir -p "${TMPSCAFFOLD}/.github/workflows"

COMPAT_DATE=$(date +%Y-%m-%d)

# CLAUDE.md
cat > "${TMPSCAFFOLD}/CLAUDE.md" << CLAUDEEOF
# ${DOMAIN}

Domain stood up ${COMPAT_DATE}. Positioning **TBD** — do not invent.

Currently serves a brand-neutral "COMING SOON" page. No editorial pillars, no voice rules,
no audience defined yet. All of that gets written *after* Jesse provides the brief.

## Stack

- Astro 5 under \`site/\`. Static output to \`site/dist/\`.
- Cloudflare Workers + static-assets binding. Worker name on CF: **\`${WORKER_NAME}\`**.
- Repo: \`${GITHUB_REPO}\` (private), SSH alias \`git@github-bourneash:\`.
- Email Routing: \`contact@\`, \`takedown@\`, catch-all → \`jessetamburino@hotmail.com\`.
- CI: \`.github/workflows/security-and-build.yml\`

## Do not, without an explicit brief from Jesse

- Add content beyond "COMING SOON"
- Invent editorial pillars, voice, palette, audience, or revenue thesis
- Create ops/, role docs, queued tasks, or affiliate registry
CLAUDEEOF

# package.json
cat > "${TMPSCAFFOLD}/site/package.json" << PKGEOF
{
  "name": "${SITE_NAME}",
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "astro dev --host 0.0.0.0",
    "start": "astro dev --host 0.0.0.0",
    "build": "astro build",
    "preview": "npm run build && wrangler dev --config dist/server/wrangler.json",
    "astro": "astro",
    "security:audit": "npm audit --audit-level=high",
    "security:audit:prod": "npm audit --omit=dev --audit-level=high",
    "ci:verify": "npm run security:audit:prod && npm run build",
    "deploy": "npm run build && wrangler deploy --config dist/server/wrangler.json",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "@astrojs/cloudflare": "12",
    "@astrojs/rss": "^4",
    "@astrojs/sitemap": "^3",
    "astro": "^6"
  },
  "devDependencies": {
    "wrangler": "^4"
  }
}
PKGEOF

# astro.config.mjs — no tailwind (coming-soon uses inline styles)
cat > "${TMPSCAFFOLD}/site/astro.config.mjs" << ASTREOF
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: 'https://${DOMAIN}',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'auto' },
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
  adapter: cloudflare()
});
ASTREOF

# wrangler.jsonc — no main/assets fields; adapter v13 generates dist/server/wrangler.json
# Deploy with: wrangler deploy --config dist/server/wrangler.json
cat > "${TMPSCAFFOLD}/site/wrangler.jsonc" << WRANEOF
{
  "\$schema": "node_modules/wrangler/config-schema.json",
  "name": "${WORKER_NAME}",
  "compatibility_date": "${COMPAT_DATE}",
  "observability": { "enabled": true },
  "compatibility_flags": [
    "global_fetch_strictly_public",
    "nodejs_compat"
  ]
}
WRANEOF

# tsconfig.json
cat > "${TMPSCAFFOLD}/site/tsconfig.json" << 'TSEOF'
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "types": ["@astrojs/cloudflare"]
  }
}
TSEOF

# index.astro — coming soon
cat > "${TMPSCAFFOLD}/site/src/pages/index.astro" << INDEXEOF
---
const title = '${DOMAIN}';
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="robots" content="noindex" />
    <style>
      html, body {
        margin: 0; padding: 0; min-height: 100vh;
        background: #fff; color: #111;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      main {
        min-height: 100vh; display: flex;
        align-items: center; justify-content: center; padding: 2rem;
      }
      .stack { text-align: center; }
      h1 {
        font-size: clamp(1.5rem, 4vw, 2.25rem);
        font-weight: 600; letter-spacing: 0.18em; margin: 0 0 1rem;
      }
      a { color: #111; text-decoration: underline; text-underline-offset: 4px; }
      .muted { font-size: 0.875rem; color: #666; margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <div class="stack">
        <h1>COMING SOON</h1>
        <p class="muted"><a href="mailto:contact@${DOMAIN}">contact@${DOMAIN}</a></p>
      </div>
    </main>
  </body>
</html>
INDEXEOF

# robots.txt
cat > "${TMPSCAFFOLD}/site/public/robots.txt" << ROBEOF
User-agent: *
Disallow: /go/
Disallow: /admin/
Disallow: /api/
Sitemap: https://${DOMAIN}/sitemap-index.xml
ROBEOF

# .assetsignore — prevents wrangler from treating _worker.js dir as a static asset
echo '_worker.js' > "${TMPSCAFFOLD}/site/public/.assetsignore"

# _headers — OWASP security headers
cat > "${TMPSCAFFOLD}/site/public/_headers" << 'HDRSEOF'
/*
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), camera=(), microphone=()

/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=31536000, immutable
HDRSEOF

# .gitignore for the site sub-repo
cat > "${TMPSCAFFOLD}/.gitignore" << 'GIEOF'
node_modules/
dist/
.env
.env.local
.wrangler/
GIEOF

# CI workflow
cat > "${TMPSCAFFOLD}/.github/workflows/security-and-build.yml" << 'CIEOF'
name: Security and Build

on:
  pull_request:
  push:
    branches:
      - main

defaults:
  run:
    working-directory: site

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: site/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Dependency audit (production deps, high+)
        run: npm run security:audit:prod
      - name: Build
        run: npm run build
      - name: Upload build artifact
        if: github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: site/dist/client
          retention-days: 7
CIEOF

# ── 2. npm install + build ─────────────────────────────────────────────────
echo "--- npm install (${DOMAIN}) ---"
npm --prefix "${TMPSCAFFOLD}/site" install

echo "--- npm run build (${DOMAIN}) ---"
npm --prefix "${TMPSCAFFOLD}/site" run build
echo "--- Build OK ---"

# ── 3. Git init + commit + push to GitHub ──────────────────────────────────
cd "${TMPSCAFFOLD}"
git init -q -b main
git add -A
git -c commit.gpgsign=false commit -q -m "Initial scaffold — coming soon"
gh repo create "${GITHUB_REPO}" --private --description "${DOMAIN} — coming soon"
git remote add origin "git@github-bourneash:${GITHUB_REPO}.git"
git push -u origin main
echo "--- Pushed to github.com/${GITHUB_REPO} ---"

# ── 4. Register as submodule in parent repo ────────────────────────────────
cd "${DOMAINS_ROOT}"
git submodule add "git@github-bourneash:${GITHUB_REPO}.git" "sites/${DOMAIN}"
echo "--- Registered as submodule: sites/${DOMAIN} ---"

# ── 5. CF email routing ────────────────────────────────────────────────────
echo "--- CF email routing for ${DOMAIN} ---"
ZONE_RESP=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
ZONE_ID=$(echo "${ZONE_RESP}" | python3 -c \
  'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"]) if r else print("")')

NS_NOTE=""
if [ -z "${ZONE_ID}" ]; then
  echo "  WARNING: CF zone not found for ${DOMAIN} — add domain to CF first, then run:"
  echo "  ${SCRIPT_DIR}/setup-cf-email.sh ${DOMAIN}"
else
  CF_STATUS=$(echo "${ZONE_RESP}" | python3 -c \
    'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["status"]) if r else print("")')
  echo "  Zone ID: ${ZONE_ID}  (status: ${CF_STATUS})"

  # If zone is pending, extract the NS values and note current registrar NS
  if [ "${CF_STATUS}" = "pending" ]; then
    NS_NOTE=$(echo "${ZONE_RESP}" | python3 -c "
import json,sys
z = json.load(sys.stdin)['result'][0]
cf_ns  = z.get('name_servers', [])
cur_ns = z.get('original_name_servers', [])
lines  = ['## Nameserver Update Required', '']
lines += ['CF-assigned nameservers (set these at your registrar):']
lines += ['  ' + ns for ns in cf_ns]
lines += ['']
lines += ['Current nameservers (at registrar now):']
lines += ['  ' + ns for ns in cur_ns]
lines += ['']
lines += ['After NS propagates, run:']
lines += ['  tools/scripts/setup-cf-email.sh ${DOMAIN}']
print('\n'.join(lines))
")
    echo "  PENDING: zone NS not yet pointing to CF — see NS_PENDING.md in site root"
    echo "${NS_NOTE}" > "${DOMAINS_ROOT}/sites/${DOMAIN}/NS_PENDING.md"
    cd "${DOMAINS_ROOT}/sites/${DOMAIN}"
    git add NS_PENDING.md
    git -c commit.gpgsign=false commit -q -m "ops: add NS_PENDING.md — nameservers not yet pointing to CF"
    git push -q origin main
    echo "  NS_PENDING.md committed to repo"
  fi

  ENABLE_RESP=$(curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/enable" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  echo "  Enable routing: $(echo "${ENABLE_RESP}" | python3 -c \
    'import json,sys; r=json.load(sys.stdin); print("OK") if r.get("success") else print(str(r.get("errors","?"))[:100])')"

  DEST="jessetamburino@hotmail.com"
  for ADDR in contact takedown; do
    RESP=$(curl -sS -X POST \
      "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"${ADDR} forward\",\"enabled\":true,\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"${ADDR}@${DOMAIN}\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"${DEST}\"]}]}")
    echo "  ${ADDR}@${DOMAIN}: $(echo "${RESP}" | python3 -c \
      'import json,sys; r=json.load(sys.stdin); print("OK") if r.get("success") else print(str(r.get("errors","?"))[:100])')"
  done

  RESP=$(curl -sS -X PUT \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules/catch_all" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"catch-all forward\",\"enabled\":true,\"matchers\":[{\"type\":\"all\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"${DEST}\"]}]}")
  echo "  catch-all: $(echo "${RESP}" | python3 -c \
    'import json,sys; r=json.load(sys.stdin); print("OK") if r.get("success") else print(str(r.get("errors","?"))[:100])')"
fi

# ── 6. Cleanup tmp ─────────────────────────────────────────────────────────
rm -rf "${TMPSCAFFOLD}"

echo ""
echo "=== DONE: ${DOMAIN} ============================================"
echo ""
echo "NEXT — Connect CF Workers to GitHub:"
echo "  1. https://dash.cloudflare.com → Workers & Pages → Create → Worker → Connect to Git"
echo "  2. Repo         : ${GITHUB_REPO}"
echo "  3. Build command: npm run build"
echo "  4. Root dir     : site"
echo "  5. Output dir   : dist/client"
echo "  6. Node version : 22"
echo "  7. Deploy command: wrangler deploy --config dist/server/wrangler.json"
echo "  8. Worker name  : ${WORKER_NAME}  (CF may auto-derive this from the repo name)"
echo ""
echo "  After worker is live and first deploy succeeds, run:"
echo "  ${SCRIPT_DIR}/bind-worker-domain.sh ${DOMAIN}"
echo ""
