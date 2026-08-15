#!/bin/bash
# Fleet-cron container entrypoint.
# 1. Sources the shared .env (DOMAINS_ROOT is bind-mounted at the same
#    absolute path as the host, so this is a plain read — no .env.shared
#    symlink indirection needed, unlike the per-site worker containers).
# 2. execs supercronic against the live-mounted crontab.docker.
set -e

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"

echo "[$(date -Iseconds)] fleet-cron starting (uid=$(id -u), gid=$(id -g))"

if [ -f "$DOMAINS_ROOT/.env" ]; then
  # shellcheck disable=SC1090
  set -a; . "$DOMAINS_ROOT/.env"; set +a
  echo "[$(date -Iseconds)] loaded .env"
fi

exec /usr/local/bin/supercronic -passthrough-logs /etc/crontab.docker
