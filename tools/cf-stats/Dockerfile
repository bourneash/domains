# cf-stats collector — long-running supercronic container.
#
# Each cron tick runs `cf-stats collect` in-process (the package is installed
# into the image). No spawned worker container is needed because cf-stats is
# a short, stateless API-collect job that just writes JSONL to a bind-mounted
# output directory.
#
# Pattern modeled on sites/americastrikes.com/ops/docker/Dockerfile.cron
# (supercronic + non-root user matching host UID 1000), simplified to one
# container since there is no claude-code / git-push / per-role state to
# isolate.

FROM python:3.12-slim

# supercronic — container-friendly cron, logs to stdout
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/supercronic \
       https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Non-root user matching host UID 1000 so bind-mounted out/ is owned by jesse.
RUN groupadd -g 1000 ops && \
    useradd -u 1000 -g ops -m -s /bin/sh ops

# Install cf-stats package
WORKDIR /opt/cf-stats
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Cron + entrypoint
COPY crontab.docker /etc/crontab.docker
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ops
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
