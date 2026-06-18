#!/usr/bin/env bash
# emit-incident.sh — write/update a machine-readable incident breadcrumb.
#
# Any cron entrypoint calls this when it aborts or detects a failure. The
# watchdog (ops/scripts/watchdog.sh) consumes these every 15 min and attempts
# auto-repair. Re-emitting the SAME failure (same fingerprint) updates one record
# rather than piling up — so a deploy that aborts every 5 min produces a single
# incident with a rising `count`, not dozens of files.
#
# Usage:
#   emit-incident.sh --role <r> --class <c> --summary <text> \
#                    [--severity high|warn] [--key <extra>] [--log <file>]
#
#   --role      which cron role / script raised it (deployer, update, engineer, probe)
#   --class     stable error class (npm-audit-high, build-fail, site-down, deploy-stuck)
#   --summary   one human line for Slack / the repair prompt
#   --severity  high (default) = wake the repair pass; warn = recorded, lower urgency
#   --key       optional extra fingerprint discriminator (e.g. a failing file/url)
#   --log       optional path to a log file; last ~40 lines are captured as excerpt
#
# Fingerprint = sha1(role:class:key)[:12]. Writes ops/health/incidents/<fp>.json.
# Never exits non-zero on its own bookkeeping — a failure to record an incident
# must not take down the caller.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INC_DIR="$REPO_ROOT/ops/health/incidents"
mkdir -p "$INC_DIR" 2>/dev/null || true

ROLE=""; CLASS=""; SUMMARY=""; SEVERITY="high"; KEY=""; LOGFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)     ROLE="${2:-}"; shift 2 ;;
    --class)    CLASS="${2:-}"; shift 2 ;;
    --summary)  SUMMARY="${2:-}"; shift 2 ;;
    --severity) SEVERITY="${2:-high}"; shift 2 ;;
    --key)      KEY="${2:-}"; shift 2 ;;
    --log)      LOGFILE="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$ROLE" || -z "$CLASS" ]]; then
  echo "[emit-incident] --role and --class are required" >&2
  exit 0
fi

# Stable fingerprint: same role+class+key collapses to one record.
FP=$(printf '%s:%s:%s' "$ROLE" "$CLASS" "$KEY" | sha1sum 2>/dev/null | cut -c1-12)
[[ -z "$FP" ]] && FP="$ROLE-$CLASS"   # extreme fallback if sha1sum is missing

EXCERPT=""
if [[ -n "$LOGFILE" && -f "$LOGFILE" ]]; then
  EXCERPT="$(tail -n 40 "$LOGFILE" 2>/dev/null)"
fi

# Python does the JSON read-modify-write so we never fight shell escaping and the
# update (first_seen preserved, count++, last_seen/summary refreshed) is atomic
# enough for a single-host cron. Defaults for attempts/status are seeded here and
# OWNED by the watchdog thereafter.
REC="$INC_DIR/$FP.json"
python3 - "$REC" "$FP" "$ROLE" "$CLASS" "$SEVERITY" "$SUMMARY" "$EXCERPT" <<'PY' 2>/dev/null
import json, os, sys, datetime
rec, fp, role, cls, sev, summary, excerpt = sys.argv[1:8]
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
data = {}
if os.path.exists(rec):
    try:
        with open(rec) as f: data = json.load(f)
    except Exception:
        data = {}
data.setdefault('fingerprint', fp)
data.setdefault('first_seen', now)
data.setdefault('attempts', 0)
data.setdefault('status', 'open')
data['role'] = role
data['class'] = cls
data['severity'] = sev
data['summary'] = summary
data['last_seen'] = now
data['count'] = int(data.get('count', 0)) + 1
if excerpt:
    data['log_excerpt'] = excerpt
# A fresh sighting of an escalated/resolved fingerprint re-opens it for triage,
# but preserves the attempt history so the cap still bounds the next round.
if data.get('status') == 'resolved':
    data['status'] = 'open'
tmp = rec + '.tmp'
with open(tmp, 'w') as f: json.dump(data, f, indent=2)
os.replace(tmp, rec)
print(fp)
PY
if [[ $? -ne 0 ]]; then
  echo "[emit-incident] python record write failed for $FP" >&2
  exit 0
fi

echo "[emit-incident] recorded $FP ($ROLE/$CLASS sev=$SEVERITY)" >&2
exit 0
