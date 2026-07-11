# fleet-dashboard. Needs node (server), python3 (delegates the engineer audit
# to tools/engineer-fleet/engineer-status.py), git (per-site working-tree
# status), openssh-client (git push/pull over the fleet's SSH remotes —
# git@github-bourneash:... — needs `ssh` on PATH to fork; compose mounts the
# host's ~/.ssh read-only and wires GIT_SSH_COMMAND with an explicit identity)
# and the docker CLI (the audit's cron-container liveness check). The repo is
# bind-mounted at the same absolute path as the host (see compose).
FROM node:22-alpine

RUN apk add --no-cache python3 git openssh-client docker-cli docker-cli-compose bash

# The container runs as root but the bind-mounted repos are owned by the host
# user (uid 1000), so git refuses with "detected dubious ownership". Mark the
# whole bind-mount tree safe so per-site `git status` works.
RUN git config --system --add safe.directory '*'

# Commit identity for dashboard-initiated commits (ignore/commit actions).
# Matches every site repo's own convention of a bot identity per automated actor.
RUN git config --system user.name "Fleet Dashboard" \
 && git config --system user.email "fleet-dashboard@domains.local"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server ./server

ENV FD_HOST=0.0.0.0
EXPOSE 4754
CMD ["node", "server/server.js"]
