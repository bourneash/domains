# site-tracker — long-running container.
# Two processes:
#   1. FastAPI app via uvicorn (bound to :4742)
#   2. supercronic running the collector schedule
# entrypoint.sh starts both; uvicorn in background, supercronic in foreground.

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/supercronic \
       https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SITE_TRACKER_SITES_YML=/work/tools/site-tracker/sites.yml \
    SITE_TRACKER_DB=/work/tools/site-tracker/data/facts.db

RUN groupadd -g 1000 ops && \
    useradd -u 1000 -g ops -m -s /bin/sh ops

WORKDIR /opt/site-tracker
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY crontab.docker /etc/crontab.docker
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 4742

USER ops
WORKDIR /work/tools/site-tracker
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
