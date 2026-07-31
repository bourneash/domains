#!/usr/bin/env bash
# Recreate a site's scheduler only when it cannot terminate active work.
#
# A scheduler container runs `docker compose run` clients. Recreating the
# scheduler while one is active terminates that client and its EXIT trap then
# removes the still-running worker container. The work loses its opportunity
# to persist state and report completion. This guard deliberately refuses the
# recreate instead; retry after the one-shot worker has completed (or use the
# reaper only for genuinely stuck work).
set -euo pipefail

SITE_DIR="${1:-}"
if [[ -z "$SITE_DIR" || ! -f "$SITE_DIR/docker-compose.yml" ]]; then
  echo "usage: $0 /absolute/path/to/site" >&2
  exit 2
fi

SITE_DIR="$(cd "$SITE_DIR" && pwd -P)"

mapfile -t ACTIVE_WORKERS < <(
  docker ps \
    --filter 'label=com.docker.compose.oneoff=True' \
    --filter "label=com.docker.compose.project.working_dir=$SITE_DIR" \
    --format '{{.Names}}'
)

if (( ${#ACTIVE_WORKERS[@]} > 0 )); then
  echo "Refusing to recreate cron for $(basename "$SITE_DIR"): active one-shot worker(s): ${ACTIVE_WORKERS[*]}" >&2
  echo "Retry after they finish; recreating cron now would abort them before their state and completion status are saved." >&2
  exit 75
fi

exec bash -c 'cd "$1" && docker compose up -d --force-recreate cron' _ "$SITE_DIR"
