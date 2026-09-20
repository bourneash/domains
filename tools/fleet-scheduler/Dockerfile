# fleet-scheduler — ONE container that replaces the ~38 per-site fleet-site-cron containers.
#
# Based on fleet-site-cron so jobs see the exact toolchain they ran with before
# (bash, git, docker-cli + compose, python3, node, curl, tzdata, uid-1000 `ops`).
# Stdlib-only Python on top: no new third-party supply chain.
FROM fleet-site-cron:latest

USER root
COPY src/fleetsched /opt/fleetsched/fleetsched
RUN chmod -R a=rX /opt/fleetsched
USER ops

ENV PYTHONPATH=/opt/fleetsched \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FS_DATA=/data \
    FS_HOST=0.0.0.0 \
    FS_PORT=4790

WORKDIR /data
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
    CMD ["python3", "-m", "fleetsched", "healthcheck"]
ENTRYPOINT ["python3", "-m", "fleetsched"]
CMD ["serve"]
