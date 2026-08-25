#!/usr/bin/env bash
# Cron entrypoint for the affiliate sentinel.
#
# Deliberately takes NO per-site arguments. Everything — base URL, affiliate
# tag, cloak prefix, product list, Slack channel — is derived from the site
# itself at run time, so a site is wired up by adding one crontab line and
# nothing else, and a product added next month is picked up with no edit
# anywhere. The predecessor needed six templated placeholders per site
# (BASE_URL, SITE_BRAND, GO_PREFIX, AFFILIATE_TAG, CONTENT_PATH, SLACK_*),
# every one of which was a chance for a site to drift out of sync silently.
#
# Run from the site repo root:
#   bash .monorepo-tools/affiliate-sentinel/run-affiliate-sentinel.sh
#
# Flags are passed straight through, so the manual fallbacks are:
#   ... run-affiliate-sentinel.sh --dry-run     # report only, never write
#   ... run-affiliate-sentinel.sh --no-heal     # file tasks, spend zero tokens
#
# Exit code is always 0 — a sentinel that fails a cron tick is a sentinel
# someone has to babysit. Real problems surface as Slack + task files.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
# When invoked through the container's read-only tools mount, $0's directory is
# the tool, not the site — so the site root is the caller's cwd.
SITE_ROOT="$(pwd)"
[[ -d "$SITE_ROOT/ops" ]] || { echo "[sentinel] not a site repo root: $SITE_ROOT" >&2; exit 0; }

SENTINEL="$REPO_ROOT/sentinel.py"
[[ -f "$SENTINEL" ]] || { echo "[sentinel] sentinel.py missing at $SENTINEL" >&2; exit 0; }

# .env.shared carries the Amazon + Slack credentials in the containers.
if [[ -f "$SITE_ROOT/.env.shared" ]]; then
  set -a; . "$SITE_ROOT/.env.shared"; set +a
fi

# A site brand nicer than the bare directory name, when the site publishes one.
BRAND=""
if [[ -f "$SITE_ROOT/ops/facts.yaml" ]]; then
  BRAND="$(grep -m1 -E '^\s*brand:' "$SITE_ROOT/ops/facts.yaml" 2>/dev/null \
           | sed -E 's/^\s*brand:\s*//; s/^["'"'"']//; s/["'"'"']$//')"
fi

exec python3 "$SENTINEL" \
  --site-root "$SITE_ROOT" \
  ${BRAND:+--site-brand "$BRAND"} \
  "$@"
