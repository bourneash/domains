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
  fs.writeFileSync(
    path.join(out, 'earnings-latest.json'),
    JSON.stringify([
      {
        date: '2026-09-01',
        clicks: 4,
        ordered_items: 1,
        shipped_items: 1,
        commission_income: 1.25,
      },
      { date: '2026-09-02', clicks: 6, ordered_items: 2, shipped_items: 1, commission_income: 2.5 },
    ])
  );
  const result = revenue.amazonSummary(dir);
  assert.equal(result.connected, true);
  assert.equal(result.has_data, true);
  assert.equal(result.clicks, 10);
  assert.equal(result.ordered_items, 3);
  assert.equal(result.shipped_items, 2);
  assert.equal(result.commission_income, 3.75);
});

test('amazonSummary reads the wrapped interactive Associates export', () => {
  const dir = root();
  const out = path.join(dir, 'tools', 'amz-stats', 'out');
  fs.writeFileSync(path.join(out, '.session.json'), '{}');
  fs.writeFileSync(
    path.join(out, 'earnings-latest.json'),
    JSON.stringify({
      pulled_at: '2026-09-21T11:33:33Z',
      rows: [
        {
          tracking_id: 'exampletag-20',
          clicks: 10,
          items_ordered: 2,
          items_shipped: 1,
          total_earnings: 4.92,
        },
        {
          tracking_id: 'Other',
          clicks: 6,
          items_ordered: '-',
          items_shipped: '-',
          total_earnings: '-',
        },
      ],
    })
  );
  const result = revenue.amazonSummary(dir);
  assert.equal(result.has_data, true);
  assert.equal(result.clicks, 16);
  assert.equal(result.ordered_items, 2);
  assert.equal(result.shipped_items, 1);
  assert.equal(result.commission_income, 4.92);
  assert.equal(result.owner_action_required, null);
  assert.equal(result.attribution_complete, false);
  assert.deepEqual(result.aggregate_tracking_ids, ['other']);
  assert.equal(result.aggregate_unattributed_income, 0);
});

test('keeps Amazon aggregate Other revenue visible without treating it as a site gap', () => {
  const dir = root();
  const out = path.join(dir, 'tools', 'amz-stats', 'out');
  fs.writeFileSync(path.join(out, '.session.json'), '{}');
  fs.writeFileSync(
    path.join(out, 'earnings-latest.json'),
    JSON.stringify([
      { tracking_id: 'exampletag-20', clicks: 1, total_earnings: 2 },
      { tracking_id: 'Other', clicks: 3, total_earnings: 4.92 },
    ])
  );
  fs.mkdirSync(path.join(dir, 'sites', 'example.com', 'site', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sites', 'example.com', 'site', 'src', 'affiliate.ts'),
    "'exampletag-20'"
  );
  const result = revenue.amazonSummary(dir);
  assert.equal(result.attribution_complete, true);
  assert.equal(result.attributed_income, 2);
  assert.equal(result.aggregate_unattributed_income, 4.92);
  assert.deepEqual(result.unmapped_tracking_ids, []);
  assert.equal(
    result.attribution.find(row => row.tracking_id === 'other').attribution_scope,
    'aggregate'
  );
});

test('amazonSummary attributes a unique tracking ID to its site', () => {
  const dir = root();
  const out = path.join(dir, 'tools', 'amz-stats', 'out');
  const src = path.join(dir, 'sites', 'example.com', 'site', 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'affiliate.ts'), `export const tag = 'exampletag-20';`);
  fs.writeFileSync(path.join(out, '.session.json'), '{}');
  fs.writeFileSync(
    path.join(out, 'earnings-latest.json'),
    JSON.stringify([
      {
        date: '2026-09-01',
        tracking_id: 'exampletag-20',
        clicks: 4,
        ordered_items: 1,
        commission_income: 2.5,
      },
    ])
  );
  const result = revenue.amazonSummary(dir);
  assert.equal(result.attribution_complete, true);
  assert.equal(result.attribution[0].site, 'example.com');
  assert.equal(result.attributed_income, 2.5);
});
