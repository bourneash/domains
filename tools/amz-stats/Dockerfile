# amz-stats collector — long-running supercronic container.
#
# Each cron tick runs `amz-stats collect` in-process (the package is installed
# into the image). No spawned worker container is needed because amz-stats is
# a short, stateless API-collect job that just writes JSONL to a bind-mounted
# output directory.
#
# Pattern modeled on sites/americastrikes.com/ops/docker/Dockerfile.cron
# (supercronic + non-root user matching host UID 1000), simplified to one
# container since there is no claude-code / git-push / per-role state to
# isolate.

FROM python:3.12-slim

# supercronic — container-friendly cron, logs to stdout
# git + openssh-client — taskfiler commits/pushes dead-ASIN task files
# directly to each site's repo (see src/amz_stats/taskfiler.py); git identity
# and SSH keys come from the host via bind mounts, not baked into the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/supercronic \
       https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Non-root user matching host UID 1000 so bind-mounted out/ is owned by jesse.
# Home dir is /home/jesse (not the native /home/ops), matching HOME below —
# ssh resolves ~/.ssh/config from the passwd-entry home, NOT the $HOME env
# var, so taskfiler's `git push` (via the github-bourneash Host alias) would
# silently fall back to system ssh_config and fail to resolve the alias
# otherwise.
RUN groupadd -g 1000 ops && \
    useradd -u 1000 -g ops -d /home/jesse -m -s /bin/sh ops

# taskfiler commits dead-ASIN task files directly into each site's repo
# (bind-mounted from the host at the SAME absolute path). git flags "dubious
# ownership" across a container UID boundary even when paths match, so
# blanket-trust every repo under the domains root. Baked in at build time
# (root, /etc/gitconfig) rather than at runtime — ~/.gitconfig is bind-mounted
# read-only from the host (for git identity) so `ops` can't write to it.
RUN git config --system --add safe.directory '*'

# Install amz-stats package
WORKDIR /opt/amz-stats
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir . && playwright install chromium --with-deps

# Cron + entrypoint
COPY crontab.docker /etc/crontab.docker
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ops
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
