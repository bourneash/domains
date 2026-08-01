#!/usr/bin/env bash
# Idempotent host-level self-heal for every site's scheduler container.
#
# Docker's restart policy did not recover the fleet after a daemon upgrade on
# 2026-07-06, so host cron runs this every 10 minutes. Keep this script bounded:
# one wedged Docker call must not overlap the next tick or fan out into 20 more
# recovery attempts. Failed recoveries are rate-limited to one Slack warning per
# site every six hours; a later successful recovery posts a matching resolution.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
SITES_DIR="${FLEET_SITES_DIR:-$DOMAINS_ROOT/sites}"
LOG="${FLEET_CRON_LOG:-$DOMAINS_ROOT/tools/scripts/ensure-fleet-cron.log}"
LOCK="${FLEET_CRON_LOCK:-$DOMAINS_ROOT/tools/scripts/ensure-fleet-cron.lock}"
ALERT_DIR="${FLEET_CRON_ALERT_DIR:-$DOMAINS_ROOT/tools/scripts/.ensure-fleet-cron-alerts}"
DOCKER_TIMEOUT="${FLEET_CRON_DOCKER_TIMEOUT:-20}"
UP_TIMEOUT="${FLEET_CRON_UP_TIMEOUT:-300}"
VERIFY_DELAY="${FLEET_CRON_VERIFY_DELAY:-3}"
ALERT_COOLDOWN="${FLEET_CRON_ALERT_COOLDOWN:-21600}"
NOTIFY_ENABLED="${FLEET_CRON_NOTIFY:-1}"
LOG_MAX_BYTES="${FLEET_CRON_LOG_MAX_BYTES:-5242880}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK")" "$ALERT_DIR"

# Host cron can start a new tick while a slow image build from the prior tick is
# still running. Only one fleet pass may manipulate schedulers at a time.
exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  log_size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  if [[ "$log_size" =~ ^[0-9]+$ ]] && (( log_size > LOG_MAX_BYTES )); then
    mv -f "$LOG" "$LOG.1"
  fi
fi

log() {
  printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"
}

container_status() {
  local name="$1"
  timeout "$DOCKER_TIMEOUT" docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || printf 'missing\n'
}

alert_marker() {
  printf '%s/%s.failed' "$ALERT_DIR" "$1"
}

notify_site() {
  local site="$1" message="$2" color="$3"
  [[ "$NOTIFY_ENABLED" == "1" ]] || return 0
  local notify="$SITES_DIR/$site/ops/scripts/notify-slack.sh"
  [[ -x "$notify" ]] || return 0
  local channel="domain-${site//./-}"
  timeout 20 "$notify" "$channel" "$message" "$color" >/dev/null 2>&1 || true
}

record_failure() {
  local site="$1" cron_name="$2" reason="$3"
  local marker now previous=0
  marker="$(alert_marker "$site")"
  now="$(date +%s)"
  if [[ -f "$marker" ]]; then
    previous="$(stat -c %Y "$marker" 2>/dev/null || echo 0)"
  fi
  if (( now - previous >= ALERT_COOLDOWN )); then
    notify_site "$site" \
      ":rotating_light: *$site scheduler recovery failed* — \`$cron_name\` $reason. The fleet self-healer will retry in 10 minutes." \
      "danger"
    : > "$marker"
  fi
}

record_recovery() {
  local site="$1" cron_name="$2"
  local marker
  marker="$(alert_marker "$site")"
  if [[ -f "$marker" ]]; then
    notify_site "$site" ":white_check_mark: *$site scheduler recovered* — \`$cron_name\` is running again." "good"
    rm -f "$marker"
  fi
}

# A dead Docker daemon makes every container look missing. Bail once instead of
# launching one doomed compose command per site and growing the log without bound.
if ! timeout "$DOCKER_TIMEOUT" docker info >/dev/null 2>&1; then
  log "[fleet] Docker daemon unavailable — deferring all scheduler recovery to the next tick"
  exit 1
fi

failures=0
for dir in "$SITES_DIR"/*/; do
  [[ -d "$dir" ]] || continue
  site="$(basename "$dir")"
  compose_file="$dir/docker-compose.yml"
  [[ -f "$compose_file" ]] || continue

  cron_name="$(awk '/^  cron:$/{f=1} f && /container_name:/{print; exit}' "$compose_file" | sed -E 's/.*container_name:[[:space:]]*//')"
  [[ -n "$cron_name" ]] || continue

  status="$(container_status "$cron_name")"
  if [[ "$status" == "running" ]]; then
    record_recovery "$site" "$cron_name"
    continue
  fi

  log "[$site] cron container '$cron_name' status=$status — bringing up cron service"
  if ! (cd "$dir" && timeout "$UP_TIMEOUT" docker compose up -d --no-deps cron) >> "$LOG" 2>&1; then
    log "[$site] ERROR: docker compose up failed or exceeded ${UP_TIMEOUT}s"
    record_failure "$site" "$cron_name" "could not be started"
    failures=$((failures + 1))
    continue
  fi

  if (( VERIFY_DELAY > 0 )); then
    sleep "$VERIFY_DELAY"
  fi
  verified="$(container_status "$cron_name")"
  if [[ "$verified" != "running" ]]; then
    log "[$site] ERROR: recovery command returned success but '$cron_name' status=$verified"
    record_failure "$site" "$cron_name" "is still $verified after restart"
    failures=$((failures + 1))
    continue
  fi

  log "[$site] recovered '$cron_name' successfully"
  record_recovery "$site" "$cron_name"
done

(( failures == 0 ))
