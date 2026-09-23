'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const dataquality = require('./executive-dataquality');

test('materializes and resolves deterministic telemetry-gap work items', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-data-quality-work-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const first = dataquality.sync(store, {
    coverage: {
      analytics: { missing_sites: ['a.com'] },
      revenue_attribution: { unmapped_tracking_ids: ['Other'] },
    },
  });
  assert.equal(first.created.length, 2);
  assert.deepEqual(
    store
      .listExecutiveWorkItems({ limit: 10 })
      .map(item => item.work_id)
      .sort(),
    ['data-quality:analytics:a.com', 'data-quality:revenue-attribution:other']
  );
  const second = dataquality.sync(store, { coverage: { analytics: { missing_sites: [] } } });
  assert.equal(second.resolved.length, 2);
  assert.equal(store.getExecutiveWorkItem('data-quality:revenue-attribution:other').status, 'done');
  store.close();
});

test('does not turn an analytics source outage into per-site work or resolve known gaps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-data-quality-outage-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  dataquality.sync(store, {
    contracts: [{ source: 'analytics', ok: true }],
    coverage: { analytics: { missing_sites: ['a.com'] } },
  });
  const result = dataquality.sync(store, {
    contracts: [{ source: 'analytics', ok: false }],
    coverage: { analytics: { missing_sites: ['a.com', 'b.com'] } },
  });
  assert.equal(result.created.length, 0);
  assert.equal(result.resolved.length, 0);
  assert.equal(store.getExecutiveWorkItem('data-quality:analytics:a.com').status, 'open');
  assert.equal(store.getExecutiveWorkItem('data-quality:analytics:b.com'), null);
  store.close();
});

test('reopens a returned gap without stale resolution metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-data-quality-reopen-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  dataquality.sync(store, {
    contracts: [{ source: 'analytics', ok: true }],
    coverage: { analytics: { missing_sites: ['a.com'] } },
  });
  store.updateExecutiveWorkItem('data-quality:analytics:a.com', {
    status: 'cancelled',
    resolution_note: 'Cancelled during a temporary source outage.',
  });

  const result = dataquality.sync(store, {
    contracts: [{ source: 'analytics', ok: true }],
    coverage: { analytics: { missing_sites: ['a.com'] } },
  });

  assert.equal(result.updated.length, 1);
  const reopened = store.getExecutiveWorkItem('data-quality:analytics:a.com');
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolved_at, null);
  assert.equal(reopened.resolution_note, null);
  store.close();
});
