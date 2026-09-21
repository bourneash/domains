#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CADENCE="${1:---cadence}"
VALUE="${2:-six_hour}"
if [[ "$CADENCE" != "--cadence" ]]; then
  echo "usage: $0 --cadence six_hour|daily|weekly|deep_dive [site]" >&2
  exit 2
fi
"$ROOT/tools/executive/checkin.sh"
FOCUS="${3:-}"
if [[ -n "$FOCUS" ]]; then
  EXECUTIVE_FOCUS_SITE="$FOCUS" node - "$ROOT" "$VALUE" <<'NODE'
const root = process.argv[2];
const cadence = process.argv[3];
const reports = require(`${root}/tools/fleet-dashboard/server/domain-reports`);
reports.generate({ root, cadence, focusSite: process.env.EXECUTIVE_FOCUS_SITE || null })
  .then(report => process.stdout.write(JSON.stringify({ report_id: report.report_id, cadence, summary: report.summary }) + '\n'))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
else
  node - "$ROOT" "$VALUE" <<'NODE'
const root = process.argv[2];
const cadence = process.argv[3];
const reports = require(`${root}/tools/fleet-dashboard/server/domain-reports`);
reports.generate({ root, cadence })
  .then(report => process.stdout.write(JSON.stringify({ report_id: report.report_id, cadence, summary: report.summary }) + '\n'))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
fi
