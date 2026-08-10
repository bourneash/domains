#!/usr/bin/env bash
# Start media-gen in the background, logging to media-gen.log.
# Foreground: uvicorn media_gen.api:app --host 0.0.0.0 --port 4780 --reload
#
# Binds 0.0.0.0 (all interfaces) — this host has real LAN/VPN interfaces
# beyond loopback and docker0, so the app enforces the actual intended
# reachability itself (loopback + docker0 bridge only) via the
# _RestrictToLocalAndDocker middleware in api.py, rather than depending on
# the bind address alone. See that middleware's comment for the full story
# (found + fixed 2026-08-10 wiring the first real container caller —
# reviewtattoo's guide-writer role got Connection Refused against a
# loopback-only bind; a docker0-only bind fixed that but broke host-local
# testing in the process — this is the version that does both correctly).
set -euo pipefail
cd "$(dirname "$0")"
nohup python3 -m uvicorn media_gen.api:app --host 0.0.0.0 --port 4780 \
  > media-gen.log 2>&1 &
echo "media-gen starting (pid $!) — logs in $(pwd)/media-gen.log"
sleep 1
curl -sf http://127.0.0.1:4780/health && echo || echo "not up yet — check the log"
