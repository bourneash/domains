'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const snapshot = require('./executive-snapshot');
const executiveData = require('./executive-data');

test('fulfills an executive telemetry request from the scheduled snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-data-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com'), { recursive: true });
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  snapshot.write(root, {
    generated_at: new Date().toISOString(),
    scope: { managed_sites: ['example.com'] },
    sources: { analytics: { ok: true, sessions: 42 } },
    decision_support: { analytics: { configured_sites: 1, sessions: 42 } },
  });

  const response = await executiveData.fulfill({
    store,
    root,
    request: {
      requested_by: 'cfo',
      question: 'What analytics evidence is available?',
      sources: ['analytics'],
      sites: ['example.com'],
    },
    managedSites: ['example.com'],
  });
  assert.equal(response.status, 'fulfilled');
  assert.equal(response.source, 'scheduled-snapshot');
  const result = executiveData.read(root, response.request_id);
  assert.equal(result.sources.analytics.sessions, 42);
  assert.equal(store.list({ event_type: 'executive.data-fulfilled' }).length, 1);
  assert.match(store.listExecutiveMessages()[0].body, /Data request fulfilled/);
  store.close();
});
