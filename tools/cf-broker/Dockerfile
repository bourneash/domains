# Deliberately python:slim with no pip installs: this process holds the
# account-scoped Cloudflare token, so its dependency surface is stdlib + PyYAML
# (registry parsing) and nothing else. Nothing here executes site content.
FROM python:3.11-slim
RUN pip install --no-cache-dir PyYAML==6.0.2 \
 && useradd -u 1000 -m ops
USER ops
WORKDIR /app
COPY --chown=ops:ops broker.py /app/broker.py
ENV CF_BROKER_HOST=0.0.0.0 CF_BROKER_PORT=4788 \
    CF_BROKER_ROOT=/repo CF_BROKER_TOKEN_MAP=/app/tokens.json
EXPOSE 4788
ENTRYPOINT ["python3", "/app/broker.py"]
