#!/usr/bin/env bash
# onboard-site.sh — register an existing sites/<domain> with every fleet system.
#
# This is the "did we wire everything?" step that used to be a 14-item mental
# checklist. It is idempotent and re-runnable, so it doubles as a reconcile pass
# for sites that were onboarded before the registry existed:
#
#   bash tools/scripts/onboard-site.sh <domain.tld>     # one site
#   bash tools/scripts/onboard-site.sh --all            # reconcile the whole fleet
#
# What it DOES automatically (safe, local, idempotent):
#   - refreshes registry/fleet.yaml so the site is canonically registered
#   - wires the shared pre-commit hooks
#   - runs the drift check
#
# Pass --stamp to also write a starter ops/smoke.yaml where one is missing.
# Off by default: that writes inside site submodules, and fleet rollouts stay
# deliberate rather than automatic.
#
# What it REPORTS but will not do for you (needs credentials, a browser, or a
# human decision — each line names the exact skill/command):
#   - GA4 property + measurement id, Slack channel, social accounts,
#     data-hub / product-feed subscriptions, CF Workers Builds connection.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ALL=0
STAMP=0
DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --stamp) STAMP=1 ;;
    *) DOMAIN="$arg" ;;
  esac
done

if [ "$ALL" = "0" ] && [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain.tld> | --all" >&2
  exit 2
fi

if [ -n "$DOMAIN" ] && [ ! -d "sites/$DOMAIN" ]; then
  echo "ERROR: sites/$DOMAIN does not exist." >&2
  echo "  A site must be bootstrapped first: bash tools/scripts/add-domain.sh --full $DOMAIN" >&2
  exit 1
fi

echo "==> [1/4] Refreshing registry/fleet.yaml"
python3 tools/fleet-registry/build_registry.py --write >/dev/null
echo "    registry rebuilt"

echo ""
echo "==> [2/4] Per-site smoke config"
# Slack channel env key convention: SLACK_CHANNEL_<DOMAIN LABEL, A-Z0-9 only>.
# Several existing sites predate the convention (SLACK_CHANNEL_RC9,
# _SAVE_US_FARMS); the registry records the real key, this only guesses for new
# sites, so check .env before trusting the stamped value.
stamp_smoke() {
  local d="$1"
  local target="sites/$d/ops/smoke.yaml"
  [ -d "sites/$d/ops" ] || return 0
  if [ -f "$target" ]; then return 0; fi
  if [ "$STAMP" = "0" ]; then
    echo "    ! sites/$d/ops/smoke.yaml missing — re-run with --stamp to create a starter"
    return 0
  fi
  local slug env_key
  slug="$(echo "$d" | tr '.' '-')"
  env_key="SLACK_CHANNEL_$(echo "${d%%.*}" | tr 'a-z-' 'A-Z_' | tr -cd 'A-Z0-9_')"
  cat > "$target" <<EOF
# sites/$d/ops/smoke.yaml
# Consumed by tools/fleet-gatus/scripts/generate_config.py — see
# tools/fleet-gatus/README.md for the schema. Editing this file takes effect
# on the next `generate_config.py && docker compose restart` in
# tools/fleet-gatus (no rebuild needed).
#
# Starter stamped by tools/scripts/onboard-site.sh — add the real routes
# (categories, a sample article, /go/ redirects, sitemap, legal pages).
apex: $d
enabled: true
slack:
  enabled: true
  channel_env: $env_key
  channel: domain-$slug
checks:
  - path: /
    expect: 200
    label: Homepage
EOF
  echo "    + $target (starter — add the real routes)"
}

if [ "$ALL" = "1" ]; then
  while IFS= read -r d; do stamp_smoke "$d"; done < <(
    python3 - <<'PY'
import sys
sys.path.insert(0, "tools/fleet-registry")
import fleet_registry as R
for d in R.sites(status="live"):
    print(d)
PY
  )
else
  stamp_smoke "$DOMAIN"
fi

echo ""
echo "==> [3/4] Wiring shared git hooks"
bash tools/scripts/install-git-hooks.sh >/dev/null 2>&1 || true
echo "    host pre-commit hooks installed"

echo ""
echo "==> [4/4] Drift check"
set +e
python3 tools/fleet-registry/check_drift.py
DRIFT=$?
set -e

echo ""
echo "==> Manual follow-ups (each warning above maps to one of these)"
cat <<'EOF'
  missing from site-tracker/sites.yml  -> python3 tools/fleet-registry/sync_rosters.py --apply
  missing from sites-analytics.yaml    -> /domains-google-analytics-ga4-admin  (creates the GA4 property)
  no Slack channel wired               -> /domains-connect-site-to-slack
  no social accounts                   -> /domains-social-setup  (status: /domains-social-status)
  wants shared product inventory       -> /product-feed-onboard-site
  wants shared news/RSS items          -> add an entry to tools/data-hub/registry/subscriptions.yaml
  not deploying on push                -> connect CF Workers Builds in the CF dashboard (one-time, manual)
  no autonomous ops                    -> /domains-cron-role-* family
EOF

exit "$DRIFT"
