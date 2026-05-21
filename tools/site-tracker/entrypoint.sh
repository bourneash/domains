#!/bin/sh
# site-tracker container entrypoint.
# 1. Source /work/.env.shared so CF + GitHub creds are available to collectors.
# 2. Ensure data/ + out/ exist.
# 3. init-db (idempotent).
# 4. Start uvicorn in background, supercronic in foreground.
set -e

echo "[$(date -Iseconds)] site-tracker container starting"

ENV_SHARED="/work/.env.shared"
if [ -f "$ENV_SHARED" ]; then
  set -a; . "$ENV_SHARED"; set +a
  echo "[$(date -Iseconds)] loaded .env.shared"
else
  echo "[$(date -Iseconds)] WARNING: $ENV_SHARED missing — CF + GitHub collectors will skip"
fi

mkdir -p /work/tools/site-tracker/data /work/tools/site-tracker/out

site-tracker init-db --data-dir /work/tools/site-tracker/data

# uvicorn in background
site-tracker serve --host 0.0.0.0 --port 4742 &
echo "[$(date -Iseconds)] uvicorn started on :4742 (pid $!)"

# supercronic in foreground — absolute path required (see cf-stats entrypoint for why)
exec /usr/local/bin/supercronic -passthrough-logs /etc/crontab.docker
