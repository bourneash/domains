#!/usr/bin/env bash
# Host cron entry for the fleet tool-test sweep (tools/fleet-test/run_tests.py).
#
# WHY: ~150 first-party test files across 21 tools had no automatic runner —
# no root CI, no root test script, no cron line. They covered the control plane
# that pushes to 48 repos (fleet-dashboard), the collectors the portfolio's
# whole history rests on (cf-stats, data-hub), and the tooling that spends real
# money (amz-stats, ai-usage). The first sweep found two suites already rotted:
# social-lib's credential suite had been uncollectable since the Vaultwarden
# migration, and four data-hub metrics tests had aged out of their own 28-day
# window.
#
# The sweep is zero-AI, offline (no fleet creds are exported into the suites),
# and takes ~2.5 min fleet-wide.
#
# Notifies on TRANSITIONS only — healthy is SILENT, the same contract as the
# engineer pulse and the lint sweep:
#   - a suite that was ok and is now fail/error   (warn)
#   - a suite that was fail/error and is now ok   (ok)
#   - a tool grew first-party tests and is not in suites.yaml  (warn, drift)
# A daily "still 2 suites red" post trains everyone to ignore the channel.
#
# Env toggles:
#   FLEET_TEST_NOTIFY=0     no Slack at all (still writes reports + log)
#   FLEET_TEST_CHANNEL=...  route elsewhere than domain-ops
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/fleet-test"
LOG="${FLEET_TEST_LOG:-$TOOL_DIR/fleet-test.log}"
LOCK="${FLEET_TEST_LOCK:-$TOOL_DIR/.fleet-test.lock}"
STATE="${FLEET_TEST_STATE:-$TOOL_DIR/state.json}"
NOTIFY_ENABLED="${FLEET_TEST_NOTIFY:-1}"
LOG_MAX_BYTES="${FLEET_TEST_LOG_MAX_BYTES:-5242880}"

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

# Only SLACK_BOT_TOKEN is wanted here. The suites deliberately run with the
# environment as-inherited (run_tests.py never sources .env into them) so a
# unit test can't reach live Cloudflare/Amazon/Slack — sourcing the fleet
# envfile in this wrapper would hand every suite the full credential set.
if [[ -f "$DOMAINS_ROOT/.env" ]]; then
  SLACK_BOT_TOKEN="$(grep -m1 '^SLACK_BOT_TOKEN=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)"
  FLEET_TEST_CHANNEL="${FLEET_TEST_CHANNEL:-$(grep -m1 '^FLEET_TEST_CHANNEL=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)}"
  export SLACK_BOT_TOKEN FLEET_TEST_CHANNEL
fi

# Pin the interpreter. Under cron, PATH is /usr/bin:/bin and `python3` is the
# distro 3.12, which has none of the fleet's test toolchain — the sweep would
# report every suite as `error` and Slack a wall of false alarms on its first
# scheduled run. The toolchain lives in pyenv 3.11.10.
PY_BIN="${FLEET_TEST_PYTHON:-}"
if [[ -z "$PY_BIN" ]]; then
  for cand in /home/jesse/.pyenv/versions/3.11.10/bin/python3 "$(command -v python3)"; do
    if [[ -x "$cand" ]] && "$cand" -c 'import pytest, yaml' 2>/dev/null; then
      PY_BIN="$cand"; break
    fi
  done
fi
if [[ -z "$PY_BIN" ]]; then
  log "no interpreter with pytest+pyyaml found — sweep skipped"
  exit 0
fi
export FLEET_TEST_PYTHON="$PY_BIN"

# Same problem for node. Cron's /usr/bin/node is the distro's v18, which does
# not auto-detect ESM in a `.js` file — data-hub-images' client test fails with
# "Cannot use import statement outside a module" there and passes on the
# fleet's actual node (nvm v23). Prepend the nvm bin dir when it exists so the
# sweep tests what the fleet really runs.
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
[[ -n "$NVM_BIN" && -x "$NVM_BIN/node" ]] && export PATH="$NVM_BIN:$PATH"

REPORT="$(timeout 1800 "$PY_BIN" "$TOOL_DIR/run_tests.py" --json 2>>"$LOG")"
rc=$?
# Pure-bash prefix test on purpose: `printf | head -c1 | grep` looks natural
# but SIGPIPEs printf, and under `set -o pipefail` that makes the whole
# pipeline return 141 even when grep matched — the guard fires on every
# healthy sweep.
if [[ -z "$REPORT" || "${REPORT:0:1}" != "{" ]]; then
  log "sweep failed to produce a report (exit $rc)"
  exit 0
fi

# One python pass diffs this report against the last one and emits the
# shell-consumable lines. It also rewrites the state file.
eval "$(python3 - "$REPORT" "$STATE" <<'PY'
import json, shlex, sys
from pathlib import Path

report = json.loads(sys.argv[1])
state_path = Path(sys.argv[2])

prev = {}
if state_path.exists():
    try:
        prev = json.loads(state_path.read_text()).get("suites", {})
    except (json.JSONDecodeError, OSError):
        prev = {}

now = {r["suite"]: r for r in report["suites"]}
bad = {"fail", "error"}

broke, fixed = [], []
for name, row in now.items():
    was, is_ = prev.get(name), row["status"]
    if is_ in bad and was not in bad and was is not None:
        broke.append(name)
    elif is_ in bad and was is None:          # first sighting of a red suite
        broke.append(name)
    elif is_ == "ok" and was in bad:
        fixed.append(name)

print("BROKE=(%s)" % " ".join(shlex.quote(n) for n in sorted(broke)))
print("FIXED=(%s)" % " ".join(shlex.quote(n) for n in sorted(fixed)))
for name in broke:
    row = now[name]
    key = name.replace("-", "_").replace(".", "_")
    counts = ", ".join(f"{v} {k}" for k, v in sorted((row.get("counts") or {}).items()))
    detail = "\n".join(x for x in (
        f"status: {row['status']}" + (f" — {row['note']}" if row.get("note") else ""),
        f"counts: {counts}" if counts else "",
        f"cmd: {row.get('cmd', '')}",
        "```" + (row.get("output_tail") or "").strip()[-1200:] + "```"
        if row.get("output_tail") else "",
    ) if x)
    print("DETAIL_%s=%s" % (key, shlex.quote(detail)))
    print("STATUS_%s=%s" % (key, shlex.quote(row["status"])))

drift = report.get("drift") or []
print("DRIFT_N=%d" % len(drift))
print("DRIFT_TOOLS=%s" % shlex.quote(", ".join(d["tool"] for d in drift)))
prev_drift = []
if state_path.exists():
    try:
        prev_drift = json.loads(state_path.read_text()).get("drift", [])
    except (json.JSONDecodeError, OSError):
        prev_drift = []
print("DRIFT_NEW=%s" % shlex.quote(", ".join(
    sorted({d["tool"] for d in drift} - set(prev_drift)))))

s = report["summary"]
print('SUMMARY=%s' % shlex.quote(
    f'{s["ok"]} ok, {s["fail"]} failed, {s["error"]} errored, {s["skip"]} skipped '
    f'of {s["total"]} in {s["duration_s"]}s'))

state_path.write_text(json.dumps({
    "generated_at": report["generated_at"],
    "suites": {n: r["status"] for n, r in now.items()},
    "drift": [d["tool"] for d in drift],
}, indent=2) + "\n")
PY
)"

log "sweep ok — $SUMMARY | broke=${#BROKE[@]} fixed=${#FIXED[@]} drift=$DRIFT_N"

notify() {
  local status="$1" headline="$2" detail="$3"
  [[ "$NOTIFY_ENABLED" == "1" ]] || return 0
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] || return 0
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site fleet --role fleet-test --status "$status" \
    --headline "$headline" --detail "$detail" \
    --channel-env FLEET_TEST_CHANNEL --channel-default domain-ops \
    >/dev/null 2>&1 || true
}

for suite in "${BROKE[@]:-}"; do
  [[ -n "$suite" ]] || continue
  key="${suite//-/_}"; key="${key//./_}"
  d_var="DETAIL_${key}"; s_var="STATUS_${key}"
  verb="$([[ "${!s_var}" == "error" ]] && echo "can no longer run" || echo "is failing")"
  notify warn "tools/${suite} $verb" "${!d_var:-}"
  log "notified — $suite went ${!s_var}"
done

for suite in "${FIXED[@]:-}"; do
  [[ -n "$suite" ]] || continue
  notify ok "tools/${suite} is green again" "Verified by tools/fleet-test/run_tests.py"
  log "notified — $suite recovered"
done

if [[ -n "${DRIFT_NEW:-}" ]]; then
  notify warn "Untested-by-the-sweep tool(s): ${DRIFT_NEW}" \
    "These have first-party test files but no entry in tools/fleet-test/suites.yaml, so the fleet sweep never runs them. Add a suite entry (or an explicit skip with a reason)."
  log "notified — roster drift: $DRIFT_NEW"
fi

exit 0
