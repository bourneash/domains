FROM node:22-alpine

# docker CLI is required so server.js can shell out to manage sibling containers.
# bash for the entrypoint convenience; tini for proper signal handling.
RUN apk add --no-cache docker-cli bash tini

WORKDIR /app

# Install deps first for layer caching.
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/server.js ./server.js
COPY server/public ./public

# Run as UID 1000 so files (state.json) written by the panel are owned by jesse on host.
USER 1000:1000

EXPOSE 7777
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
