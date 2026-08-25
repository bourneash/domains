#!/usr/bin/env bash
# build-quiet.sh — fleet-shared wrapper for `npm run <script>` (astro build /
# build:dry, or any comparably verbose build) that keeps a page-by-page build
# log out of an LLM session's context on the (overwhelmingly common)
# clean-build path.
#
# Root cause this exists for (2026-08-25 token-usage audit, 0daynews.com):
# `astro build` prints one line per built page. On any site with a real
# content corpus that's hundreds to thousands of lines — pure noise on a
# pass — and when a role's own prompt tells the model to run the build
# itself, that whole blob lands directly in the Bash tool result and stays
# resident in context (billed as cache-read on every subsequent turn) for
# the rest of the session. Confirmed as a real cost driver on 0daynews.com
# (2547 lines / 2441 pages, one call every news-writer session).
#
# This does NOT apply to build steps a bash wrapper already runs on the
# agent's behalf outside its own turns (e.g. americastrikes.com's
# post-write.sh, or any role whose doc says "do NOT run npm run build
# yourself") — those never reach the model's context regardless of
# verbosity, so there's nothing to fix there. This is only for roles whose
# own prompt instructs the model to run the build itself.
#
# Usage: build-quiet.sh <site-dir> <npm-script-name>
#   site-dir          directory to run `npm run` in (usually .../site)
#   npm-script-name   the package.json script to run (build, build:dry, ...)
#
# Exit code matches the underlying `npm run`. On success, prints only the
# last few lines (page count / duration — enough to confirm it actually
# ran). On failure, prints the FULL captured output — nothing is ever
# hidden when a build actually breaks, only the noise on a pass.
set -uo pipefail

SITE_DIR="${1:?usage: build-quiet.sh <site-dir> <npm-script-name>}"
SCRIPT_NAME="${2:?usage: build-quiet.sh <site-dir> <npm-script-name>}"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

( cd "$SITE_DIR" && npm run "$SCRIPT_NAME" ) > "$LOG" 2>&1
STATUS=$?

if [[ $STATUS -eq 0 ]]; then
  tail -5 "$LOG"
else
  echo "npm run $SCRIPT_NAME FAILED (in $SITE_DIR) — full output follows:"
  cat "$LOG"
fi
exit "$STATUS"
