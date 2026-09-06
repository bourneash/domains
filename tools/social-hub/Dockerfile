FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir \
       fastapi uvicorn click pyyaml rich httpx atproto tweepy praw pyotp \
    && npm install -g @anthropic-ai/claude-code@2.1.140 @bitwarden/cli@2026.6.0

RUN mkdir -p /home/jesse && chown node:node /home/jesse

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/home/jesse/projects/domains/tools/social-hub/container-entrypoint.sh"]
