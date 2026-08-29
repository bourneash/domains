#!/usr/bin/env bash
# tail-proxy.sh — stream proxy access logs for the current container session only.
# Logs shown are from last container start; nothing is retained after restart.
#
# Usage:
#   ./tail-proxy.sh        # both nodes side by side
#   ./tail-proxy.sh us     # US exit only
#   ./tail-proxy.sh eu     # EU exit only
#   ./tail-proxy.sh random # random exit only

set -euo pipefail

CYAN='\033[0;36m'
YEL='\033[1;33m'
NC='\033[0m'

node="${1:-all}"

start_since() {
  local name="$1"
  docker inspect "$name" --format='{{.State.StartedAt}}' 2>/dev/null || echo "1970-01-01T00:00:00Z"
}

stream_node() {
  local name="$1"
  local color="$2"
  local label="$3"
  local since
  since=$(start_since "$name")
  docker logs -f --since "$since" "$name" 2>&1 | sed -u "s/^/${color}[${label}]${NC} /"
}

case "$node" in
  us)
    echo -e "${CYAN}Tailing vpn-us (logs since last start) — Ctrl-C to stop${NC}"
    stream_node vpn-us "$CYAN" "US"
    ;;
  eu)
    echo -e "${YEL}Tailing vpn-eu (logs since last start) — Ctrl-C to stop${NC}"
    stream_node vpn-eu "$YEL" "EU"
    ;;
  random)
    echo -e "Tailing vpn-random (logs since last start) — Ctrl-C to stop"
    stream_node vpn-random "${NC}" "RANDOM"
    ;;
  all)
    echo -e "Tailing ${CYAN}vpn-us${NC} + ${YEL}vpn-eu${NC} + vpn-random (logs since last start) — Ctrl-C to stop"
    stream_node vpn-us "$CYAN" "US" &
    PID_US=$!
    stream_node vpn-eu "$YEL" "EU" &
    PID_EU=$!
    stream_node vpn-random "${NC}" "RANDOM" &
    PID_RANDOM=$!
    trap "kill $PID_US $PID_EU $PID_RANDOM 2>/dev/null; exit 0" INT TERM
    wait
    ;;
  *)
    echo "Usage: $0 [us|eu|random|all]" >&2
    exit 1
    ;;
esac
