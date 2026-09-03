# Fleet-level cron driver — the six cross-cutting jobs that used to live on
# jesse's host crontab (see README.md and HANDOFF.md). Same supercronic
# pattern every site's ops/docker/Dockerfile.cron already uses, based on
# node:22-alpine instead of bare alpine because job 6 (domain-job-runner.sh)
# needs node >= 22 + npm + gh to drive domain-manager-cli.sh. Alpine's own
# `nodejs` package (3.20 base) is too old and doesn't carry `github-cli` in
# its stable repo at a usable version — node:22-alpine (Alpine 3.24 under the
# hood) has both at the pinned Node version for free. This makes the image
# heavier than a per-site cron image; see README.md for the two-service split
# alternative if that bloat becomes a problem.

FROM node:22-alpine

# node:22-alpine ships a `node` user at uid/gid 1000 — remove it so `ops` can
# take that uid instead. Every fleet worker container runs as uid 1000
# (feedback_worker_containers_run_as_uid1000); a root-run `docker compose up`
# or `git submodule add` from job 6 corrupts bind-mounted repo state.
RUN deluser node

# py3-yaml: job 7's check_drift.py parses registry/fleet.yaml + per-site
# registry files.
RUN apk add --no-cache \
    bash \
    curl \
    python3 \
    py3-yaml \
    git \
    openssh-client \
    tzdata \
    ca-certificates \
    docker-cli \
    docker-cli-compose \
    github-cli

# supercronic — small static binary, container-friendly cron. Same pinned
# version + sha256 as sites/americastrikes.com/ops/docker/Dockerfile.cron.
RUN wget -O /usr/local/bin/supercronic \
    https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && echo "a51b340a83c5bd035742f0d7191555f9663876405e494dbf824537d64f3e39c6  /usr/local/bin/supercronic" | sha256sum -c \
    && chmod +x /usr/local/bin/supercronic

# Claude Code CLI — job 4 (check-claude-auth.sh) runs `claude -p` directly
# against the shared host OAuth session mounted below. Same pinned version as
# sites/americastrikes.com/ops/docker/Dockerfile.worker so both images drift
# together deliberately, not by accident.
RUN npm install -g @anthropic-ai/claude-code@2.1.140

# Bitwarden CLI — env-broker (job 14) and social_lib.vault_store shell out to
# `bw` for every vault read/write. It was never installed in this image, so
# every vault call here failed with "[Errno 2] No such file or directory:
# 'bw'" and env-broker fell back to fleet-wide values instead of per-site
# vault reads. Same ARG name/version as
# tools/fleet-images/worker/Dockerfile's BITWARDEN_CLI_VERSION so the two
# images are bumped together, not independently by hand.
ARG BITWARDEN_CLI_VERSION=2026.6.0
RUN npm install -g @bitwarden/cli@${BITWARDEN_CLI_VERSION}

ENV TZ=America/New_York

# uid 1000 / gid 1000 matches the host `jesse` user so bind-mounted files
# stay host-owned, not root-owned. docker_host group (gid 1004) matches the
# host `docker` group (verify with `getent group docker`) so this user can
# reach /var/run/docker.sock.
RUN addgroup -g 1004 docker_host && \
    addgroup -g 1000 ops && \
    adduser -u 1000 -G ops -h /home/ops -s /bin/bash -D ops && \
    adduser ops docker_host

# HOME is overridden to the HOST's home (see docker-compose.yml comment) so
# nested `docker compose` invocations against OTHER sites' compose files
# resolve ${HOME}-based bind specs against the real host path. That means
# /home/jesse inside THIS container is not the ops user's native home
# (/home/ops) — Docker auto-creates it root-owned as an implicit mount
# parent, which left job 4's `claude -p` unable to write its own state
# (~/.claude.json) and hang until timeout. Pre-create it ops-owned so the
# named volume mounted here in docker-compose.yml seeds with the right
# permissions on first use.
RUN mkdir -p /home/jesse && chown ops:ops /home/jesse

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ops

# crontab.docker is bind-mounted live (not COPYed) — see README.md "editing
# the schedule". This avoids the crontab-baked-into-the-image trap that has
# already cost the fleet unscheduled jobs on the per-site cron images
# (project_cron_image_drift_2026-08-10).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
