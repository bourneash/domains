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
