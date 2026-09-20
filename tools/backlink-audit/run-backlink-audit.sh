#!/usr/bin/env bash
set -euo pipefail

ROOT="${DOMAINS_ROOT:-/home/jesse/projects/domains}"
exec node "$ROOT/tools/backlink-audit/audit.js" --root "$ROOT"
