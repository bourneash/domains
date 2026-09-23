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

test('deduplicates repeated source-gap rows before syncing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-data-quality-dedupe-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const result = dataquality.sync(store, {
    contracts: [{ source: 'analytics', ok: true }],
    coverage: { analytics: { missing_sites: ['a.com', 'a.com'] } },
  });

  assert.equal(result.created.length, 1);
  assert.equal(store.listExecutiveWorkItems({ source_type: 'data-quality' }).length, 1);
  store.close();
});

test('updates an existing work ID created by an older executive source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-data-quality-legacy-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  store.createExecutiveWorkItem({
    work_id: 'data-quality:revenue-attribution:other',
    title: 'Legacy attribution case',
    kind: 'evidence',
    status: 'in_progress',
    owner: 'cfo',
    source_type: 'executive-tick',
    source_id: 'revenue-attribution:other',
  });

  const result = dataquality.sync(store, {
    coverage: { revenue_attribution: { unmapped_tracking_ids: ['other'] } },
  });

  assert.equal(result.updated.length, 1);
  assert.equal(
    store.getExecutiveWorkItem('data-quality:revenue-attribution:other').source_type,
    'data-quality'
  );
  store.close();
});
