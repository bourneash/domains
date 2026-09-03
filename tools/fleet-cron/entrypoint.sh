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

# Fail loud, not quiet, on a missing required CLI. Job 14 (env-broker) and
# any social_lib.vault_store caller shell out to `bw` — its absence used to
# surface hours later as "[Errno 2] No such file or directory: 'bw'" deep in
# a cron log, with env-broker silently falling back to fleet-wide (unscoped)
# credentials in the meantime instead of anyone noticing the container was
# built wrong (2026-09-03 incident). Better to refuse to start.
if ! command -v bw >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] FATAL: bw CLI not found on PATH — rebuild the image (see Dockerfile's @bitwarden/cli install)" >&2
  exit 1
fi

exec /usr/local/bin/supercronic -passthrough-logs /etc/crontab.docker
