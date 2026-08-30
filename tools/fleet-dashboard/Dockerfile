# fleet-dashboard. Needs node (server), python3 (delegates the engineer audit
# to tools/engineer-fleet/engineer-status.py), git (per-site working-tree
# status), openssh-client (git push/pull over the fleet's SSH remotes —
# git@github-bourneash:... — needs `ssh` on PATH to fork; compose mounts the
# host's ~/.ssh read-only and wires GIT_SSH_COMMAND with an explicit identity)
# and the docker CLI (the audit's cron-container liveness check).
#
# The repo is bind-mounted at the same absolute path as the host, and compose
# sets `working_dir` to tools/fleet-dashboard inside that mount — NOT to this
# image's /app. That's deliberate, not incidental: several server/*.js files
# (githygiene.js → tools/fleet-git, aioptimizer.js's Python side, etc.) reach
# sideways into OTHER tools/* directories via `__dirname`-relative requires,
# which only exist on the live bind-mounted tree, never inside this image (it
# only ever gets `server/`). So the server genuinely has to run from that
# mounted path, and `node_modules` has to live there too, on the HOST
# filesystem, for require() to find express/js-yaml/etc. via its normal
# upward search from the running script's real location.
#
# The npm install below, and the /app copy of server/, exist ONLY as a
# build-time smoke test (catch a broken package.json/lockfile at `docker
# compose build`, not at 3am when the container restarts) — nothing at
# runtime executes from /app. docker-entrypoint.sh is what actually keeps
# the bind-mounted tree's own node_modules present: it installs into the
# mounted directory itself on first boot (or after a `git clean`/fresh
# clone wipes it — gitignored, same as every other node_modules in this
# repo), so a full container recreate can't wedge in a MODULE_NOT_FOUND
# crash-loop the way skipping this once did.
FROM node:22-alpine

RUN apk add --no-cache python3 git openssh-client docker-cli docker-cli-compose bash

# The bind-mounted repos are owned by the host user, so git refuses with
# "detected dubious ownership" unless the tree is marked safe. --system so it
# applies to whichever user runs the server.
RUN git config --system --add safe.directory '*'

# Commit identity for dashboard-initiated commits (ignore/commit actions).
# Matches every site repo's own convention of a bot identity per automated actor.
RUN git config --system user.name "Fleet Dashboard" \
 && git config --system user.email "fleet-dashboard@domains.local"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server ./server

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# ── run as uid 1000, never root ─────────────────────────────────────────────
# This container mounts the ENTIRE domains monorepo read-write AND the docker
# socket, and it runs `git add`/`commit`/`push` against those repos from the
# Git tab. As root every one of those writes lands in .git owned by root, which
# is the documented way this fleet has already corrupted .git/objects on four
# sites — unrecoverable without sudo, which is unavailable on this host.
#
# node:22-alpine ships `node` at uid 1000 / gid 1000, which is exactly the host
# user that owns the repos, so the switch needs no uid remapping — only
# ownership of /app (created root-owned by COPY + npm install above) and, in
# compose, the docker group for socket access plus an SSH mount at this user's
# real home.
#
# OpenSSH resolves ~/.ssh from the PASSWD home dir, not $HOME — for `node` that
# is /home/node, which is why compose mounts the keys there rather than /root.
RUN chown -R node:node /app

ENV FD_HOST=0.0.0.0
EXPOSE 4754
USER node
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
