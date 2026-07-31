#!/usr/bin/env bash
# bounce-crons.sh — rebuild and restart cron containers across all sites
#
# Discovers every sites/*/ with a docker-compose.yml that has a `cron` service,
# then runs: docker compose build cron && recreate-cron-safely.sh <site>.
# The guard refuses a recreate while an active one-shot worker belongs to the
# site, rather than silently aborting that work.
#
# Usage:
#   ./tools/cron-bouncer/bounce-crons.sh              # bounce ALL sites
#   ./tools/cron-bouncer/bounce-crons.sh americastrikes.com broadwayshowgirls.com

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SITES_DIR="$REPO_ROOT/sites"

# Compose files use ${HOME}/projects/domains/.env in bind mounts. If HOME is
# wrong (e.g. sudo, cron-of-crons), the mount source becomes /root/... and
# Docker silently creates a directory instead of mounting the file → exit 127.
EXPECTED_HOME="/home/jesse"
if [ "${HOME:-}" != "$EXPECTED_HOME" ]; then
  echo -e "${RED:-}ERROR: HOME='${HOME:-<unset>}' — expected '$EXPECTED_HOME'. Run as jesse or set HOME explicitly.${NC:-}" >&2
  exit 1
fi

# --- colour helpers ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
info() { echo -e "  ${CYAN}→${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
header() { echo -e "\n${CYAN}═══ $* ═══${NC}"; }

# --- discover sites ---
discover_sites() {
  local -a found=()
  for compose_file in "$SITES_DIR"/*/docker-compose.yml; do
    local site_dir
    site_dir="$(dirname "$compose_file")"
    # must have a `cron:` service
    if grep -q "^  cron:" "$compose_file" 2>/dev/null; then
      found+=("$(basename "$site_dir")")
    fi
  done
  printf '%s\n' "${found[@]}"
}

# --- bounce one site ---
bounce_site() {
  local site="$1"
  local site_dir="$SITES_DIR/$site"

  if [ ! -f "$site_dir/docker-compose.yml" ]; then
    fail "$site — no docker-compose.yml found"
    return 1
  fi
  if ! grep -q "^  cron:" "$site_dir/docker-compose.yml" 2>/dev/null; then
    fail "$site — no cron service in docker-compose.yml"
    return 1
  fi

  header "$site"

  # Build with --no-cache is slow; just build (uses layer cache but picks up
  # changed files like Dockerfile, crontab, scripts).
  # CRITICAL: cd into site_dir so $PWD resolves correctly for compose files that
  # use ${PWD} in working_dir and bind mounts (docker compose -f without cd
  # leaves PWD at the caller's cwd, baking the wrong path into the container).
  info "building cron image..."
  if (cd "$site_dir" && docker compose build cron 2>&1 | sed 's/^/    /'); then
    ok "build complete"
  else
    fail "build failed — skipping restart"
    return 1
  fi

  info "restarting cron service (only if no worker is active)..."
  if "$REPO_ROOT/tools/scripts/recreate-cron-safely.sh" "$site_dir" 2>&1 | sed 's/^/    /'; then
    ok "restarted"
  else
    fail "restart skipped or failed"
    return 1
  fi

  # Give the container a moment to settle before inspecting — a container can
  # briefly show "running" then crash within the first second.
  sleep 3

  # Use docker compose ps (authoritative) rather than grep+awk on YAML.
  local cron_container
  cron_container="$(cd "$site_dir" && docker compose ps --format '{{.Name}}' cron 2>/dev/null | head -1)"

  if [ -z "$cron_container" ]; then
    warn "$site — could not determine cron container name; skipping post-restart check"
    return 0
  fi

  local status
  status="$(docker inspect --format='{{.State.Status}}' "$cron_container" 2>/dev/null || echo "unknown")"
  if [ "$status" != "running" ]; then
    fail "$site — container $cron_container status: $status (expected running)"
    return 1
  fi

  # Verify working dir is the site dir, not the repo root — the exact failure
  # mode that caused the 2026-06-24 outage when bounce ran without cd.
  local actual_wd
  actual_wd="$(docker exec "$cron_container" pwd 2>/dev/null || echo "exec-failed")"
  if [ "$actual_wd" != "$site_dir" ]; then
    fail "$site — container working dir '$actual_wd' != expected '$site_dir'"
    return 1
  fi

  ok "container $cron_container is running with correct working dir"
  return 0
}

# --- main ---
main() {
  local -a targets=()

  if [ $# -eq 0 ]; then
    # discover all
    while IFS= read -r site; do
      targets+=("$site")
    done < <(discover_sites | sort)
    echo -e "${CYAN}Bouncing all ${#targets[@]} cron containers...${NC}"
  else
    targets=("$@")
    echo -e "${CYAN}Bouncing ${#targets[@]} site(s): ${targets[*]}${NC}"
  fi

  local passed=0 failed=0
  local -a failed_sites=()

  for site in "${targets[@]}"; do
    if bounce_site "$site"; then
      (( passed++ )) || true
    else
      (( failed++ )) || true
      failed_sites+=("$site")
    fi
  done

  echo ""
  echo -e "${CYAN}════════════════════════════════${NC}"
  echo -e "${GREEN}Passed: $passed${NC}   ${RED}Failed: $failed${NC}"
  if [ ${#failed_sites[@]} -gt 0 ]; then
    echo -e "${RED}Failed sites: ${failed_sites[*]}${NC}"
  fi

  [ $failed -eq 0 ]
}

main "$@"
