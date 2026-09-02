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
# Exit code: 0 when the sentinel ran, whatever it found — a sentinel that fails
# a cron tick over a dead ASIN is a sentinel someone has to babysit, and real
# findings surface as Slack + task files. But an INFRASTRUCTURE failure (no
# usable interpreter, missing sentinel.py, an unhandled traceback) exits
# non-zero so run-fleet.sh can count it and alert. Those two cases were
# conflated before, which is how three days of import crashes read as green.
# Exit 4 is neither: it means the run was fine but the Amazon API was down and
# that was the only finding, so the site stayed quiet and run-fleet.sh reports
# the whole fleet's outage in one line. run-fleet.sh treats 4 as checked.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
# When invoked through the container's read-only tools mount, $0's directory is
# the tool, not the site — so the site root is the caller's cwd.
SITE_ROOT="$(pwd)"
[[ -d "$SITE_ROOT/ops" ]] || { echo "[sentinel] not a site repo root: $SITE_ROOT" >&2; exit 3; }

SENTINEL="$REPO_ROOT/sentinel.py"
[[ -f "$SENTINEL" ]] || { echo "[sentinel] sentinel.py missing at $SENTINEL" >&2; exit 3; }

# Interpreter resolution is explicit — never the ambient `python3`. See
# bin/ensure-venv for why (cron's PATH gets a different python than a shell's).
PYTHON="$("$REPO_ROOT/bin/ensure-venv")" || exit 3

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

exec "$PYTHON" "$SENTINEL" \
  --site-root "$SITE_ROOT" \
  ${BRAND:+--site-brand "$BRAND"} \
  "$@"
