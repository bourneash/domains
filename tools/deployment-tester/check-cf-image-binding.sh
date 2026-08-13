#!/usr/bin/env bash
# Flags sites using @astrojs/cloudflare v14+ with no explicit imageService set
# on the adapter. v14 defaults imageService to 'cloudflare-binding', which
# injects an unprovisioned IMAGES binding into the generated wrangler config —
# wrangler deploy then fails on CF with no local-build signal (astro build
# succeeds; only the real CF Workers Build fails). Root-caused 2026-08-13 on
# saveusfarms.com (dc44232a); same landmine found & preempted fleet-wide on
# amputeenews, broadwayshowgirls, reviewtattoo, rodhat, weirdgirlstore,
# wetpages, shoptopless. aliencouncil already carried the fix.
#
# Fix: adapter config needs an explicit imageService, e.g.
#   adapter: cloudflare({ imageService: 'passthrough' })
# ('passthrough' is correct for sites using plain <img>; 'compile' is the
# alternative for sites that lean on astro:assets — check what's already used
# elsewhere in the fleet before picking one.)
#
# Usage: bash tools/deployment-tester/check-cf-image-binding.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

fail=0
for cfg in sites/*/site/astro.config.mjs; do
  site="$(echo "$cfg" | cut -d/ -f2)"
  pkg="sites/$site/site/package.json"
  lock="sites/$site/site/package-lock.json"
  [ -f "$pkg" ] || continue
  grep -q '"@astrojs/cloudflare"' "$pkg" 2>/dev/null || continue

  # Resolve the version CF will actually install (lockfile, not local node_modules)
  ver=""
  if [ -f "$lock" ]; then
    ver=$(python3 -c "
import json
try:
    d = json.load(open('$lock'))
    print(d.get('packages', {}).get('node_modules/@astrojs/cloudflare', {}).get('version', ''))
except Exception:
    pass
" 2>/dev/null)
  fi
  major="${ver%%.*}"
  [ -n "$major" ] && [ "$major" -ge 14 ] 2>/dev/null || continue

  if ! grep -q "imageService" "$cfg"; then
    echo "❌ $site: @astrojs/cloudflare $ver, no imageService set on adapter — $cfg"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "✅ all @astrojs/cloudflare v14+ sites have imageService set"
fi
exit "$fail"
