'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const view = require('./changequeue-view');

test('explains queue blockers using the same site locks as dispatch', () => {
  const request = { status: 'queued', site: 'example.com', delivery_mode: 'direct' };
  const blockers = view.queueBlockers(request, {
    activeCount: 2,
    capacity: 2,
    busySites: new Set(['example.com']),
    measuringSites: new Set(['example.com']),
  });
  assert.deepEqual(blockers.map(item => item.code), ['capacity', 'site_active', 'measurement_window']);
  assert.match(blockers[1].detail, /build or review/);
});

test('report-only work can proceed during a measurement window', () => {
  const blockers = view.queueBlockers(
    { status: 'queued', site: 'example.com', delivery_mode: 'report_only' },
    { activeCount: 0, capacity: 2, measuringSites: new Set(['example.com']) }
  );
  assert.deepEqual(blockers, []);
});

test('enriches requests with registry context and retry state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changequeue-view-'));
  fs.writeFileSync(
    path.join(root, 'DOMAINS_INDEX.md'),
    '| Domain | In use | TLDR |\n| example.com | ✅ | Example site purpose |\n'
  );
  const rows = view.enrichChangeRequests(
    root,
    [{
      request_id: '1',
      status: 'queued',
      site: 'example.com',
      next_attempt_at: '2099-01-01T00:00:00.000Z',
    }],
    { max_concurrent: 2 },
    []
  );
  assert.equal(rows[0].site_context.description, 'Example site purpose');
  assert.equal(rows[0].queue_block.primary.code, 'retry_wait');
});
