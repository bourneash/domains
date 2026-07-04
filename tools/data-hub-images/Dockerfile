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

# System libs Pillow/imagehash need for JPEG/PNG codecs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo zlib1g && \
    rm -rf /var/lib/apt/lists/*

# Install the package (pulls deps from pyproject.toml)
COPY pyproject.toml .
COPY src/ src/
RUN pip install --no-cache-dir .

# Copy registry and crontab
COPY registry/ registry/
COPY crontab.docker /app/crontab

RUN mkdir -p /data

EXPOSE 4770

# Default: run the API server.
# The collector service overrides CMD to run supercronic.
CMD ["python", "-m", "datahub_images", "serve"]
