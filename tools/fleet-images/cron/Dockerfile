# fleet-site-cron — the ONE scheduler image for every site in the fleet.
#
# Replaces 27 per-site ops/docker/Dockerfile.cron files. Those had drifted into
# 10 md5 variants, but the drift was cosmetic: 26 of 27 were functionally
# identical (same alpine 3.20.6, same package set, same supercronic release and
# checksum, same uid-1000 `ops` user) and differed only in how the layers were
# arranged. The 27th (amputeenews.com) ran as root — tracked separately as the
# root-ownership migration.
#
# DELIBERATELY NOT BUMPED. The base stays alpine:3.20.6 — what 26/27 sites
# already run — so this migration's diff is purely structural (sharing +
# unbaking), never a runtime change. Bumping the base is now a one-line edit
# rolled through fleet-image-build with a canary, which is the whole point;
# do it as its own change, not smuggled into the consolidation.
#
# WHAT IS *NOT* IN THIS IMAGE, ON PURPOSE:
#   - the crontab. It is bind-mounted at /etc/crontab.docker by each site's
#     compose file. Baking it was the single worst property of the old design:
#     rescheduling required an image rebuild, so schedules silently diverged
#     from the repo. Measured 2026-08-23: weapontester.com had been running a
#     `find ... -delete` that ate .gitkeep for four days after the fix was
#     committed, because nothing rebuilt its image. Never bake the crontab.
#   - anything site-specific at all. If you find yourself wanting a site
#     conditional here, it belongs in that site's crontab or its ops/ scripts.
# Base pinned by DIGEST, not just tag. A tag is mutable: `alpine:3.20.6` can be
# republished, so a rebuild months from now could silently produce a different
# image from the one the fleet was verified against — and with 26 sites on one
# image, "silently different" is the expensive kind of surprise.
#
# The cost is that security updates no longer arrive for free on rebuild. That
# is the intended trade: updates become a deliberate, reviewed, smoke-gated
# bump instead of an invisible one.
#
# To bump:  tools/fleet-images/bin/fleet-image-bases --update
#           then rebuild; fleet-image-smoke gates the promotion.
FROM alpine:3.20.6@sha256:de4fe7064d8f98419ea6b49190df1abbf43450c1702eeb864fe9ced453c1cc5f

# Package set is the UNION of what every site's crontab actually invokes, not
# a guess. Audited across all 27 crontabs on 2026-08-23:
#   git            — 23 scheduled lines (deployer gates use `git ls-files`)
#   nodejs/npm     — 10 lines (npm 7, npx 2, node 1; e.g. saveusfarms' War
#                    Room data refresh runs at cron level, not in a worker)
#   docker-cli(+compose) — every role invocation is `docker compose run --rm`
#   python3        — notify-slack.sh and friends
#   bash           — every ops script has a bash shebang
# One shared image can afford the union; 27 copies could not, which is exactly
# why they each carried a different subset and broke differently.
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    docker-cli \
    docker-cli-compose \
    git \
    nodejs \
    npm \
    python3 \
    tzdata \
    wget

# supercronic — cron built for containers: logs to stdout, no syslog, no
# daemonising. Pinned by release AND sha256; `ADD --checksum` fails the build
# on mismatch rather than trusting the download.
ADD --checksum=sha256:a51b340a83c5bd035742f0d7191555f9663876405e494dbf824537d64f3e39c6 \
    https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    /usr/local/bin/supercronic
RUN chmod 0755 /usr/local/bin/supercronic

ENV TZ=America/New_York

# Non-root user matching host uid 1000 (jesse), so every file this container
# writes into the bind-mounted site repo is owned by jesse rather than root.
# This is a hard fleet invariant: a root-owned write into a mounted repo has
# already corrupted .git/objects on four sites and is not recoverable without
# sudo. docker_host (gid 1004) mirrors the host docker group so `ops` can read
# /var/run/docker.sock.
RUN addgroup -g 1004 docker_host \
    && addgroup -g 1000 ops \
    && adduser -u 1000 -G ops -h /home/ops -s /bin/sh -D ops \
    && adduser ops docker_host

COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint-cron.sh

# Traceability: fleet-doctor reads this to tell "running the current shared
# image" from "running something that merely answers to the same tag".
ARG FLEET_IMAGE_VERSION=dev
LABEL org.domains.fleet.image="fleet-site-cron" \
      org.domains.fleet.version="${FLEET_IMAGE_VERSION}"
ENV FLEET_IMAGE_VERSION=${FLEET_IMAGE_VERSION}

USER ops
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/entrypoint-cron.sh"]
