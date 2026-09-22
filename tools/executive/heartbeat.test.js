'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const eventstore = require('../fleet-dashboard/server/eventstore');
const heartbeat = require('./heartbeat');

test('heartbeat records every check but avoids repeating an unchanged inbox message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-heartbeat-'));
  try {
    const first = heartbeat.run({ root, now: new Date('2026-09-22T01:00:00.000Z') });
    const second = heartbeat.run({ root, now: new Date('2026-09-22T02:00:00.000Z') });
    assert.equal(first.message?.metadata?.kind, 'executive-heartbeat');
    assert.equal(second.message, null);
    const store = eventstore.open(root);
    assert.equal(store.list({ event_type: 'executive.heartbeat', limit: 10 }).length, 2);
    assert.equal(store.listExecutiveMessages({ limit: 10 }).length, 1);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
