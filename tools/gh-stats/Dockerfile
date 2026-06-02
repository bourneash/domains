# gh-stats collector — long-running supercronic container.
# Mirrors tools/cf-stats/Dockerfile: supercronic + non-root UID 1000,
# package installed into the image, hourly `gh-stats collect`.

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/supercronic \
       https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd -g 1000 ops && \
    useradd -u 1000 -g ops -m -s /bin/sh ops

WORKDIR /opt/gh-stats
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY crontab.docker /etc/crontab.docker
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ops
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
