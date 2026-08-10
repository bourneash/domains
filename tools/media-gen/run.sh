#!/usr/bin/env bash
# Start media-gen in the background, logging to media-gen.log.
# Foreground: uvicorn media_gen.api:app --host 127.0.0.1 --port 4780 --reload
set -euo pipefail
cd "$(dirname "$0")"
nohup python3 -m uvicorn media_gen.api:app --host 127.0.0.1 --port 4780 \
  > media-gen.log 2>&1 &
echo "media-gen starting (pid $!) — logs in $(pwd)/media-gen.log"
sleep 1
curl -sf http://127.0.0.1:4780/health && echo || echo "not up yet — check the log"
