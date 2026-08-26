#!/usr/bin/env bash
# Flags sites that schedule the seo-analyst cron role but whose `worker`
# docker-compose service (the container that actually runs the role, via
# `run-worker.sh` -> `docker compose run worker seo-analyst`) is missing
# DATAHUB_API — the env var the role's own prompt uses to pull GSC/click
# data. DATAHUB_API is commonly wired onto the `cron` service (which spawns
# workers, doesn't itself run Claude) and left off `worker`, which makes
# every seo-analyst run silently GSC-blind. Root-caused fleet-wide 2026-08-26
# on ultrarough.com (found while chasing an unrelated cron-collision failure);
# same gap found & fixed on 0daynews, aliencouncil, americastrikes,
# amputeenews, newmomshop, saveusfarms, stinkyleftfoot, weapontester, xxxtea.
#
# Fix: give the `worker` service, alongside its other environment: entries,
#   DATAHUB_API: ${DATAHUB_API:-http://datahub-api:4760}
# and make sure it also joins the vpn_proxy network (add a top-level
#   vpn_proxy:
#     external: true
#     name: vpn-proxy_default
# block if the site doesn't already have one, and add vpn_proxy to the
# worker service's `networks:` list) — datahub-api is only reachable by
# container-name DNS on that network.
#
# Usage: bash tools/deployment-tester/check-seo-analyst-datahub-wiring.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

fail=0
for cf in sites/*/ops/docker/crontab.docker; do
  site="$(echo "$cf" | cut -d/ -f2)"
  compose="sites/$site/docker-compose.yml"
  [ -f "$compose" ] || continue

  # Only care about an ACTIVE (non-comment) seo-analyst schedule.
  grep -qE '^\s*[0-9*,/-]+\s+[0-9*,/-]+.*run-worker\.sh seo-analyst' "$cf" 2>/dev/null || continue

  # Extract just the `worker:` service block (up to the next top-level
  # `  <name>:` service key) and check it directly, not the whole file —
  # DATAHUB_API is often present on `cron` and that must not count.
  worker_block="$(awk '/^  worker:/{f=1} f && /^  [a-zA-Z_-]+:/ && !/^  worker:/{exit} f' "$compose")"

  if ! grep -q 'DATAHUB_API' <<<"$worker_block"; then
    echo "MISSING DATAHUB_API on worker: $site"
    fail=1
  elif ! grep -q 'vpn_proxy' <<<"$worker_block"; then
    echo "DATAHUB_API set but worker not on vpn_proxy network: $site"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "OK — every site running seo-analyst has DATAHUB_API wired on its worker service."
fi
exit "$fail"
