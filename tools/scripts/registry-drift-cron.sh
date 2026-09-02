#!/usr/bin/env bash
# Host cron entry for the fleet registry drift check.
#
# Zero-AI, ~0.3s: filesystem + YAML parsing only. Follows the lint-sweep
# contract — healthy is SILENT, and a finding is only announced the first tick
# it appears. A daily "still 16 warnings" post trains everyone to ignore the
# channel, which is how the last round of drift went unnoticed for months.
#
# Self-heals pure-derived drift (capabilities/worker gone stale, or an
# on-disk site missing its registry entry) via `check_drift.py --fix` before
# reporting — those ERRORs mean "nobody reran build_registry.py after adding
# a roster entry," not a real problem, so fixing them here is what stops that
# class from ever reaching Slack.
#
# Notifies on:
#   - any remaining ERROR (orphaned registry entry — needs a human delete
#     call, --fix won't touch it) — first tick only
#   - a warning that was not present on the previous run
#   - each individual finding clearing (per-site), plus the whole run going
#     clean after a non-clean one
#
# Env toggles:
#   REGISTRY_DRIFT_NOTIFY=0    no Slack (still logs)
#   REGISTRY_DRIFT_CHANNEL     route all alerts to one ops channel
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/fleet-registry"
LOG="${REGISTRY_DRIFT_LOG:-$TOOL_DIR/drift.log}"
LOCK="${REGISTRY_DRIFT_LOCK:-$TOOL_DIR/.drift.lock}"
STATE="${REGISTRY_DRIFT_STATE:-$TOOL_DIR/.drift-state.json}"
NOTIFY_ENABLED="${REGISTRY_DRIFT_NOTIFY:-1}"
LOG_MAX_BYTES="${REGISTRY_DRIFT_LOG_MAX_BYTES:-2097152}"

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

REPORT="$(timeout 120 python3 "$TOOL_DIR/check_drift.py" --fix --json 2>>"$LOG")"
if [[ -z "$REPORT" ]]; then
  log "drift check produced no output — skipping"
  exit 0
fi

# Emit shell-consumable lines: SUMMARY, then NEW <site> <text> for findings that
# were not in the previous state, then CLEARED=1 when a dirty run goes clean.
eval "$(python3 - "$REPORT" "$STATE" <<'PY'
import json, os, shlex, sys

report = json.loads(sys.argv[1])
state_path = sys.argv[2]
findings = [("ERROR", t) for t in report["errors"]] + [("WARN", t) for t in report["warnings"]]

try:
    with open(state_path) as fh:
        previous = set(json.load(fh).get("findings", []))
except (OSError, ValueError):
    previous = set()

current = {f"{kind}:{text}" for kind, text in findings}
new = sorted(current - previous)
cleared = sorted(previous - current)

print("SUMMARY=%s" % shlex.quote(f'{len(report["errors"])} error(s), {len(report["warnings"])} warning(s)'))
if report.get("fixed"):
    print("SELF_HEALED=1")
print("NEW_COUNT=%d" % len(new))
print("CLEARED=%d" % (1 if previous and not current else 0))
print("CLEARED_COUNT=%d" % len(cleared))
for i, item in enumerate(new):
    kind, text = item.split(":", 1)
    site = text.split(":", 1)[0].strip()
    print("NEW_%d_SITE=%s" % (i, shlex.quote(site)))
    print("NEW_%d_KIND=%s" % (i, shlex.quote(kind)))
    print("NEW_%d_TEXT=%s" % (i, shlex.quote(text.split(":", 1)[1].strip())))
for i, item in enumerate(cleared):
    kind, text = item.split(":", 1)
    site = text.split(":", 1)[0].strip()
    print("CLEARED_%d_SITE=%s" % (i, shlex.quote(site)))
    print("CLEARED_%d_TEXT=%s" % (i, shlex.quote(text.split(":", 1)[1].strip())))

os.makedirs(os.path.dirname(state_path), exist_ok=True)
with open(state_path, "w") as fh:
    json.dump({"findings": sorted(current)}, fh, indent=1)
PY
)"

log "drift check — $SUMMARY, new=$NEW_COUNT, cleared=$CLEARED_COUNT${SELF_HEALED:+ (self-healed)}"

notify() {
  local site="$1" status="$2" headline="$3"
  [[ "$NOTIFY_ENABLED" == "1" ]] || return 0
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] || return 0
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site "$site" --role registry-drift --status "$status" \
    --headline "$headline" \
    --detail "Run \`bash tools/scripts/onboard-site.sh $site\` to reconcile." \
    --channel-env REGISTRY_DRIFT_CHANNEL \
    --channel-default "domain-${site//./-}" >/dev/null 2>&1 || true
}

for (( i = 0; i < NEW_COUNT; i++ )); do
  site_var="NEW_${i}_SITE"; kind_var="NEW_${i}_KIND"; text_var="NEW_${i}_TEXT"
  site="${!site_var}"; kind="${!kind_var}"; text="${!text_var}"
  [[ "$kind" == "ERROR" ]] && status=fail || status=warn
  notify "$site" "$status" "Fleet registry drift: $text"
  log "notified $site ($kind: $text)"
done

# Per-finding all-clear: notify the site the moment ITS finding resolves,
# rather than waiting for the whole fleet-wide run to go clean (which may
# never happen while unrelated sites carry their own open warnings).
for (( i = 0; i < CLEARED_COUNT; i++ )); do
  site_var="CLEARED_${i}_SITE"; text_var="CLEARED_${i}_TEXT"
  site="${!site_var}"; text="${!text_var}"
  notify "$site" "ok" "Fleet registry drift resolved: $text"
  log "cleared $site ($text)"
done

if [[ "$CLEARED" == "1" ]]; then
  log "all registry drift cleared"
fi

exit 0
