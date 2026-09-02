# Alert relay — see relay.js for why this process exists.
# No dependencies by design: node's stdlib http + global fetch is the whole
# runtime, so there is no lockfile to drift and no npm install in the build.
FROM node:22-alpine

# uid 1000 `node` already exists in this image; run as it, never as root
# (fleet rule: worker containers do not run as root).
WORKDIR /app
COPY relay.js ./
USER node

EXPOSE 8581
HEALTHCHECK --interval=120s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8581/health >/dev/null 2>&1 || exit 1

CMD ["node", "relay.js"]
