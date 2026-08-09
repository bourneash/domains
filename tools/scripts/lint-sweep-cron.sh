#!/usr/bin/env bash
# Host cron entry for the fleet lint sweep (tools/lint-fleet/lint-sweep.py).
#
# The sweep itself is zero-AI: prettier + string parsing, ~25s fleet-wide. This
# wrapper adds the fleet conventions around it — one run at a time, a rotating
# log, and Slack only when something actually changed. Healthy is SILENT, same
# contract as the engineer pulse: a daily "still 23 broken files" post trains
# everyone to ignore the channel.
#
# Notifies on:
#   - a parse error that was not there on the previous sweep  (warn, per site)
#   - a site's last parse error clearing                      (ok, per site)
#
# Env toggles:
#   LINT_SWEEP_NOTIFY=0      no Slack at all (still writes reports + log)
#   LINT_SWEEP_FILE_TASKS=1  queue an engineering task on each affected site's
#                            board so that site's engineer role fixes it. OFF by
#                            default — turn it on when you want the fleet to
#                            self-heal these instead of just reporting them.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/lint-fleet"
LOG="${LINT_SWEEP_LOG:-$TOOL_DIR/lint-sweep.log}"
LOCK="${LINT_SWEEP_LOCK:-$TOOL_DIR/.lint-sweep.lock}"
NOTIFY_ENABLED="${LINT_SWEEP_NOTIFY:-1}"
FILE_TASKS="${LINT_SWEEP_FILE_TASKS:-0}"
LOG_MAX_BYTES="${LINT_SWEEP_LOG_MAX_BYTES:-5242880}"

mkdir -p "$TOOL_DIR"

# A slow sweep must never overlap the next tick.
exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  log_size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  if [[ "$log_size" =~ ^[0-9]+$ ]] && (( log_size > LOG_MAX_BYTES )); then
    mv -f "$LOG" "$LOG.1"
  fi
fi

log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

ARGS=(--root "$DOMAINS_ROOT" --json)
[[ "$FILE_TASKS" == "1" ]] && ARGS+=(--file-tasks)

REPORT="$(timeout 900 python3 "$TOOL_DIR/lint-sweep.py" "${ARGS[@]}" 2>>"$LOG")"
rc=$?
if (( rc != 0 )) || [[ -z "$REPORT" ]]; then
  log "sweep failed (exit $rc)"
  exit 0
fi

# One python pass reads the report and emits the shell-consumable lines we need:
#   SUMMARY <sites> <broken> <parse_errors> <unformatted>
#   NEW <site> <count>        parse errors that appeared since the last sweep
#   FIXED <site>              site had parse errors last sweep, has none now
#   TASK <path>
eval "$(python3 - "$REPORT" <<'PY'
import json, sys, shlex
r = json.loads(sys.argv[1])
s = r["summary"]
print(f'SUMMARY="{s["sites"]} {s["broken"]} {s["parse_errors"]} {s["unformatted"]}"')

new = {}
for item in r.get("new_parse_errors", []):
    new.setdefault(item["site"], []).append(item["file"])
broken_now = {row["site"] for row in r["sites"] if row["parse_errors"]}
fixed = sorted({item["site"] for item in r.get("resolved_parse_errors", [])} - broken_now)

print("NEW_SITES=(%s)" % " ".join(shlex.quote(s) for s in sorted(new)))
for site, files in new.items():
    key = site.replace(".", "_").replace("-", "_")
    print("NEW_FILES_%s=%s" % (key, shlex.quote("\n".join(files))))
print("FIXED_SITES=(%s)" % " ".join(shlex.quote(s) for s in fixed))
print("TASKS=%d" % len(r.get("tasks_filed", [])))
PY
)"

read -r n_sites n_broken n_parse n_drift <<<"$SUMMARY"
log "sweep ok — sites=$n_sites broken=$n_broken parse_errors=$n_parse unformatted=$n_drift new=${#NEW_SITES[@]} fixed=${#FIXED_SITES[@]} tasks_filed=$TASKS"

notify() {
  local site="$1" status="$2" headline="$3" detail="$4"
  [[ "$NOTIFY_ENABLED" == "1" ]] || return 0
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] || return 0
  # LINT_SWEEP_CHANNEL, if set, routes every lint alert to one ops channel
  # instead of fanning out to each site's own domain-<host> channel.
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site "$site" --role lint-sweep --status "$status" \
    --headline "$headline" --detail "$detail" \
    --channel-env LINT_SWEEP_CHANNEL \
    --channel-default "domain-${site//./-}" >/dev/null 2>&1 || true
}

for site in "${NEW_SITES[@]:-}"; do
  [[ -n "$site" ]] || continue
  key="${site//./_}"; key="${key//-/_}"
  files_var="NEW_FILES_${key}"
  files="${!files_var:-}"
  count="$(printf '%s\n' "$files" | grep -c . || true)"
  detail="$(printf '%s' "$files" | sed 's/^/`/; s/$/`/' | paste -sd$'\n' -)"
  notify "$site" warn \
    "$count file(s) prettier can no longer parse — the pre-commit hook is silently skipping them" \
    "$detail"
  log "notified $site (new parse errors: $count)"
done

for site in "${FIXED_SITES[@]:-}"; do
  [[ -n "$site" ]] || continue
  notify "$site" ok "All prettier parse errors cleared — the hook formats this site again" \
    "Verified by tools/lint-fleet/lint-sweep.py"
  log "notified $site (parse errors cleared)"
done

exit 0
