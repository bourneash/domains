#!/usr/bin/env bash
# tools/affiliate-audit/tests/test_discover.mjs.sh
# Runs discover.mjs against the fixture using totaljerks.com's local tsx
# (no external deps needed by the fixture, so any site's node_modules works).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="$(dirname "$HERE")"
SITE_DIR="$(cd "$AUDIT_DIR/../../sites/totaljerks.com/site" && pwd)"

OUT=$(cd "$SITE_DIR" && npx tsx "$HERE/../discover.mjs" "$HERE/fixtures/affiliate.fixture.ts")

echo "$OUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert len(data) == 2, f'expected 2 products, got {len(data)}'
assert data[0]['id'] == 'fixture-one'
assert data[0]['asin'] == 'B00FIXTURE1'
assert data[0]['ribbon'] == 'EDITORS_PICK'
assert data[1]['id'] == 'fixture-two'
assert data[1]['asin'] is None
assert data[1]['campaignOnly'] is True
print('OK: discover.mjs output matches fixture')
"
