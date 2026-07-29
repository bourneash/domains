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

OUT=$(cd "$SITE_DIR" && npx tsx "$HERE/../discover.mjs" "$HERE/fixtures/frontmatter-products")

echo "$OUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert [p['id'] for p in data] == ['alpha-winch-rope', 'beta-recovery-kit']
assert data[0]['name'] == 'Alpha Winch Rope'
assert data[0]['asin'] == 'B0ALPHA123'
assert data[0]['price'] == 39.95
assert data[0]['searchQuery'] == 'Alpha Winch Rope'
assert data[0]['ribbon'] == 'staff-pick'
assert data[1]['asin'] is None
assert data[1]['brand'] is None
assert data[1]['price'] is None
print('OK: discover.mjs reads frontmatter product directories')
"
