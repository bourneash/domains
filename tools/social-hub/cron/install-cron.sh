#!/usr/bin/env bash
# Install the social-hub tick on the host crontab (every 15 minutes).
#
# The tick is idempotent and cheap when there is nothing to do, so a short
# interval costs little and keeps scheduled posts landing close to their slot.
set -euo pipefail

ROOT="${DOMAINS_ROOT:-/home/jesse/projects/domains}"
LOG="$ROOT/tools/social-hub/data/tick.log"
LINE="*/15 * * * * cd $ROOT && $(command -v social-hub || echo social-hub) tick --notify >> $LOG 2>&1"

mkdir -p "$(dirname "$LOG")"

if crontab -l 2>/dev/null | grep -q "social-hub tick"; then
  echo "social-hub tick is already installed:"
  crontab -l | grep "social-hub tick"
  exit 0
fi

( crontab -l 2>/dev/null; echo "$LINE" ) | crontab -
echo "installed: $LINE"
