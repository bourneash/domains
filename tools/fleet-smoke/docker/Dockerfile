# tools/fleet-smoke/docker/Dockerfile
# Long-running cron driver for the centralized fleet-wide smoke checks.
# Uses supercronic (cron designed for containers — logs to stdout, no syslog),
# same pattern as every per-site ops/docker/Dockerfile.cron in this repo.

FROM python:3.12-alpine

RUN apk add --no-cache bash curl tzdata ca-certificates

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

RUN wget -O /usr/local/bin/supercronic \
    https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && echo "a51b340a83c5bd035742f0d7191555f9663876405e494dbf824537d64f3e39c6  /usr/local/bin/supercronic" | sha256sum -c \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=America/New_York
WORKDIR /fleet

# Non-root user matching host UID 1000 (jesse) — the ./state bind mount is
# written by this container and must stay owned by jesse on the host.
RUN addgroup -g 1000 fleet && \
    adduser -u 1000 -G fleet -h /home/fleet -s /bin/sh -D fleet

COPY lib/ /fleet/lib/
COPY run_fleet_smoke.py /fleet/run_fleet_smoke.py
COPY crontab.docker /etc/crontab.docker

RUN chown -R fleet:fleet /fleet
USER fleet


# NOTE: invoke supercronic via its absolute path, not the bare name. Its
# process-reaper re-execs os.Args[0] literally (not the PATH-resolved path),
# so a bare "supercronic" entrypoint crash-loops with "Failed to fork exec:
# no such file or directory" once cwd != the directory containing the
# binary. See https://github.com/aptible/supercronic/issues/177.
ENTRYPOINT ["/usr/local/bin/supercronic", "/etc/crontab.docker"]
