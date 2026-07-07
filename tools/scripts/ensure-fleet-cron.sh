#!/usr/bin/env bash
# Idempotent self-heal: for every site with a docker-compose.yml cron stack,
# ensure its cron container is Up. `docker compose up -d` is a no-op if it's
# already running, so this is safe to run on a tight interval from host cron.
# Exists because Docker's `restart: unless-stopped` policy did not bring the
# fleet back after a docker-ce apt upgrade restarted dockerd on 2026-07-06
# 20:41 EDT — every site's cron container died and stayed dead for 18h.
set -uo pipefail

SITES_DIR="/home/jesse/projects/domains/sites"
LOG="/home/jesse/projects/domains/tools/scripts/ensure-fleet-cron.log"

for dir in "$SITES_DIR"/*/; do
  site="$(basename "$dir")"
  compose_file="$dir/docker-compose.yml"
  [ -f "$compose_file" ] || continue

  cron_name=$(awk '/^  cron:$/{f=1} f && /container_name:/{print; exit}' "$compose_file" | sed -E 's/.*container_name:\s*//')
  [ -n "$cron_name" ] || continue

  status=$(docker inspect -f '{{.State.Status}}' "$cron_name" 2>/dev/null || echo "missing")
  if [ "$status" != "running" ]; then
    echo "$(date -Iseconds) [$site] cron container '$cron_name' status=$status — bringing up" >> "$LOG"
    (cd "$dir" && docker compose up -d) >> "$LOG" 2>&1
  fi
done
