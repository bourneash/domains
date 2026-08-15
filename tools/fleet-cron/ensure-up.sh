#!/usr/bin/env bash
# The ONE host crontab line this migration leaves behind (@reboot only).
#
# Why this exists: job 1 (ensure-fleet-cron.sh) is itself the thing that
# self-heals dead SITE scheduler containers after a docker-ce upgrade bounces
# dockerd. Once it moves into tools/fleet-cron, `restart: unless-stopped`
# handles that same failure mode for the fleet-cron container itself — Docker
# re-attaches restart policies on daemon restart. What `restart:
# unless-stopped` does NOT cover is a full host reboot where the container
# was never removed but the daemon comes up before this repo's containers are
# recreated in some edge cases, or where `docker compose down` was run and
# never brought back up. This script is the same belt-and-suspenders pattern
# home_energy's scripts/cron-reboot.sh already uses for exactly that gap.
#
# Deliberately NOT a second watchdog container watching the first — that's
# turtles all the way down. This is a single `docker compose up -d`, run once
# at boot, full stop. Ordinary health (is fleet-cron alive right now) is the
# Fleet Dashboard's job (Containers tab surfaces it automatically — see
# README.md "Visibility").
set -euo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
cd "$DOMAINS_ROOT/tools/fleet-cron"

# Give the docker daemon a moment on a cold boot before the first attempt.
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done

exec docker compose --env-file "$DOMAINS_ROOT/.env" up -d
