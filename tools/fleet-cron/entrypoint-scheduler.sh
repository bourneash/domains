#!/usr/bin/env bash
# fleet-cron entrypoint (scheduler engine). Replaces `supercronic /etc/crontab.docker` with
# tools/fleet-scheduler's `fleetsched serve` running the fleet-tool jobs as ONE group ("fleet").
# Bind-mounted from the repo by docker-compose.yml, so changing it needs no image rebuild.
#
# ROLLBACK to supercronic: delete the `entrypoint:`/scheduler env block in docker-compose.yml
# (crontab.docker is untouched and remains the legacy source) and `docker compose up -d`.
set -euo pipefail
DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
echo "[$(date -Iseconds)] fleet-cron (fleet-scheduler engine) starting (uid=$(id -u), gid=$(id -g))"

if ! command -v bw >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] FATAL: bw CLI not found on PATH — rebuild the image (see Dockerfile's @bitwarden/cli install)" >&2
  exit 1
fi
[ -s "${FS_TOKEN_FILE:?}" ] || { echo "FATAL: ${FS_TOKEN_FILE} missing/empty — run tools/fleet-cron/ensure-up.sh" >&2; exit 1; }
mkdir -p "${FS_DATA:?}"

# Pick up any line added to crontab.docker since last start. Idempotent; never overwrites
# schedules edited in the scheduler (that needs an explicit `import --update`).
python3 -m fleetsched import --crontab /etc/crontab.docker --group "${FS_GROUP:-fleet}"

exec python3 -m fleetsched serve
