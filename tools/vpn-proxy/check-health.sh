#!/usr/bin/env bash
# check-health.sh — verify both VPN containers are up and show exit IPs
set -euo pipefail

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
NC='\033[0m'

check_node() {
  local name="$1"
  local proxy_port="$2"

  echo -e "\n${YEL}── ${name} ──${NC}"

  # Docker health status (gluetun built-in healthcheck binary)
  local status
  status=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "not found")
  if [[ "$status" == "healthy" ]]; then
    echo -e "  Docker health: ${GRN}healthy${NC}"
  else
    echo -e "  Docker health: ${RED}${status}${NC}"
  fi

  # Proxy connectivity + exit IP — proves traffic flows through VPN tunnel
  local exit_ip
  exit_ip=$(curl -s --max-time 8 -x "http://127.0.0.1:${proxy_port}" https://api.ipify.org 2>/dev/null || echo "unreachable")
  if [[ "$exit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "  Exit IP (proxy :${proxy_port}): ${GRN}${exit_ip}${NC}"
  else
    echo -e "  Exit IP (proxy :${proxy_port}): ${RED}unreachable${NC}"
  fi
}

echo "VPN Proxy Health Check — $(date -u '+%Y-%m-%d %H:%M UTC')"

check_node "vpn-us" 8181
check_node "vpn-eu" 8182

echo ""
