#!/bin/sh
# Runs at container start, cwd = compose's working_dir (the bind-mounted
# tools/fleet-dashboard on the HOST, not this image's /app — see the
# Dockerfile comment for why the server has to run from there).
#
# node_modules at that path lives on the host filesystem, not in this image,
# so it doesn't survive a fresh clone, a `git clean -fdx`, or simply never
# having been installed there yet. Installing it once here — idempotent,
# skipped whenever node_modules already matches the committed lockfile —
# means a plain `docker compose up`/`--force-recreate` always works instead
# of silently crash-looping on the very first cold start or repo reset.
set -eu

if [ ! -f node_modules/.install-stamp ] || [ package-lock.json -nt node_modules/.install-stamp ]; then
  echo "docker-entrypoint: installing node_modules into the bind-mounted repo..." >&2
  # --cache: compose overrides $HOME to /home/jesse for git/ssh's sake (see
  # docker-compose.yml), but that path's own parent dirs are container-layer
  # directories Docker auto-creates root-owned when setting up the deeper
  # bind mount — npm's default cache under $HOME/.npm then can't be created
  # by uid 1000. /tmp is always writable in a fresh container.
  npm ci --omit=dev --cache /tmp/npm-cache
  touch node_modules/.install-stamp
fi

exec "$@"
