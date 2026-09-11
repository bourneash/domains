'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const revenue = require('./revenue');

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-revenue-'));
  fs.mkdirSync(path.join(dir, 'tools', 'amz-stats', 'out'), { recursive: true });
  return dir;
}

test('amazonSummary reports the missing authentication boundary', () => {
  const result = revenue.amazonSummary(root());
  assert.equal(result.connected, false);
  assert.equal(result.has_data, false);
  assert.match(result.message, /save-session/);
});

test('amazonSummary totals a completed earnings export', () => {
  const dir = root();
  const out = path.join(dir, 'tools', 'amz-stats', 'out');
  fs.writeFileSync(path.join(out, '.session.json'), '{}');
  fs.writeFileSync(path.join(out, 'earnings-latest.json'), JSON.stringify([
    { date: '2026-09-01', clicks: 4, ordered_items: 1, shipped_items: 1, commission_income: 1.25 },
    { date: '2026-09-02', clicks: 6, ordered_items: 2, shipped_items: 1, commission_income: 2.5 },
  ]));
  const result = revenue.amazonSummary(dir);
  assert.equal(result.connected, true);
  assert.equal(result.has_data, true);
  assert.equal(result.clicks, 10);
  assert.equal(result.ordered_items, 3);
  assert.equal(result.shipped_items, 2);
  assert.equal(result.commission_income, 3.75);
});
