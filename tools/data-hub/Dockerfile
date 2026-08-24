FROM python:3.11-slim

WORKDIR /app

# supercronic for cron scheduling inside the collector container
ARG SUPERCRONIC_VERSION=0.2.33
ARG SUPERCRONIC_URL=https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL "${SUPERCRONIC_URL}" -o /usr/local/bin/supercronic && \
    chmod +x /usr/local/bin/supercronic && \
    apt-get purge -y curl && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Install Python deps first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install the package in editable mode
COPY pyproject.toml .
COPY src/ src/
COPY vendor/google-auth-fleet/ vendor/google-auth-fleet/
RUN pip install --no-cache-dir -e .

# Copy registry and crontab
COPY registry/ registry/
COPY crontab.docker /app/crontab

RUN mkdir -p /data

EXPOSE 4760

# Default: run the API server.
# The collector service overrides CMD to run supercronic.
# ── run as uid 1000, never root ─────────────────────────────────────────────
# Fleet rule: nothing in this fleet runs as root unless it provably must, and
# nothing here does. uid 1000 matches the host user that owns the repos and the
# backup binds, so files this service writes stay readable/repairable without
# sudo — which is not available passwordless on this host.
#
# /data holds the live SQLite database and is a named volume. Docker only
# applies image-time ownership to a volume when the volume is EMPTY, so an
# existing root-owned volume must be chown'd once, out of band, at rollout —
# see the deploy note in the fleet-images README. Getting this wrong shows up
# as "attempt to write a readonly database", not as a startup crash.
RUN useradd -u 1000 -m -d /home/datahub datahub \
    && chown -R datahub:datahub /app /data
USER datahub

CMD ["python", "-m", "datahub", "serve"]
