# cron-manager panel. Needs the docker CLI (status + rebuild) and the repo
# bind-mounted at the SAME absolute path as the host so `docker compose`
# invocations resolve volume sources correctly.
FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose bash

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server ./server

ENV CM_HOST=0.0.0.0
EXPOSE 4753
CMD ["node", "server/server.js"]
