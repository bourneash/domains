'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('./server');
const eventstore = require('./eventstore');
const executive = require('./executive');

function request(server, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
        method,
        headers:
          body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('owner and executive team can complete a durable request/reply conversation', async t => {
  // Keep failures actionable when this integration test is run through the
  // parallel Node test reporter, which otherwise only reports the file.
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-executive-messaging-e2e-'));
    const server = createApp({ root }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));

    const question =
      "I'd like the exec team to look at https://github.com/dream-num/univer and the potential to integrate it in to our eco system so that the exec team and others can use this to create presentations and reporting outward (to owner) and for their own usages too.";
    const created = await request(server, 'POST', '/api/executive/requests', {
      actor: 'owner',
      body: question,
    });
    assert.equal(created.status, 201);
    const workId = created.body.request.work_item.work_id;
    assert.equal(created.body.request.message.actor, 'owner');

    // This is the same durable message primitive used by the executive runner
    // when CEO/CTO/CRO/CFO work produces an operator-visible response.
    const store = eventstore.open(root);
    const answer = executive.message(store, {
      actor: 'ceo',
      work_id: workId,
      reply_to: created.body.request.message.message_id,
      message_type: 'update',
      body: 'I will review Univer, its licensing, spreadsheet/document/presentation capabilities, and integration paths, then return with an evidence-backed recommendation.',
    });
    store.close();
    assert.equal(answer.work_id, workId);

    const inbox = await request(server, 'GET', '/api/executive/inbox?limit=10');
    assert.equal(inbox.status, 200);
    const tracked = inbox.body.requests.find(item => item.work_id === workId);
    assert.ok(tracked);
    assert.equal(tracked.messages.length, 2);
    assert.equal(tracked.messages[1].actor, 'ceo');
    assert.equal(tracked.lifecycle_state, 'answered');

    const followUp = await request(server, 'POST', '/api/executive/messages', {
      actor: 'owner',
      work_id: workId,
      reply_to: answer.message_id,
      message_type: 'update',
      body: 'Please include licensing, deployment, security, and a small proof-of-concept plan in the recommendation.',
    });
    assert.equal(followUp.status, 201);
    assert.equal(followUp.body.message.work_id, workId);

    const previews = await request(server, 'GET', '/api/executive/messages?limit=10&preview=1');
    assert.equal(previews.status, 200);
    const preview = previews.body.messages.find(message => message.work_id === workId);
    assert.ok(preview);
    assert.equal(preview.body, 'Please include licensing, deployment, security, and a small proof-of-concept plan in the recommendation.');
    assert.deepEqual(Object.keys(preview).sort(), ['actor', 'body', 'created_at', 'work_id']);

    const thread = await request(
      server,
      'GET',
      `/api/executive/messages?work_id=${workId}&limit=10`
    );
    assert.equal(thread.status, 200);
    assert.equal(thread.body.messages.length, 3);
    assert.equal(thread.body.messages.at(-1).actor, 'owner');
  } catch (error) {
    console.error('executive messaging E2E failure:', error);
    throw error;
  }
});

test('Product Manager summary returns role messages and proposals in one scoped response', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-product-manager-summary-e2e-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const store = eventstore.open(root);
  store.createExecutiveMessage({
    actor: 'ceo',
    body: 'Product direction for fleet',
    metadata: { to: 'product-manager-fleet' },
  });
  store.createExecutiveMessage({ actor: 'ceo', body: 'Unrelated large transcript'.repeat(500) });
  store.createExecutiveProposal({
    title: 'Fleet proposal',
    summary: 'A role scoped proposal',
    requested_action: 'Review the proposal',
    created_by: 'product-manager-fleet',
  });
  store.createExecutiveProposal({
    title: 'Sites proposal',
    summary: 'A different role proposal',
    requested_action: 'Review the proposal',
    created_by: 'product-manager-sites',
  });
  store.close();

  const response = await request(
    server,
    'GET',
    '/api/executive/product-manager-summary?role=product-manager-fleet'
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.message_count, 1);
  assert.equal(response.body.messages.length, 1);
  assert.equal(response.body.messages[0].body, 'Product direction for fleet');
  assert.equal(response.body.proposal_count, 1);
  assert.equal(response.body.proposals[0].title, 'Fleet proposal');
  assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 5000);
});

test('executive transcript pages events and loads full text only on request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-executive-transcript-page-e2e-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const store = eventstore.open(root);
  const older = store.createExecutiveMessage({
    actor: 'ceo',
    body: 'older prompt '.repeat(2000),
    message_type: 'model-prompt',
    created_at: '2026-10-01T12:00:00.000Z',
  });
  const latest = store.createExecutiveMessage({
    actor: 'ceo',
    body: 'latest response '.repeat(2000),
    message_type: 'model-response',
    created_at: '2026-10-02T12:00:00.000Z',
  });
  store.createExecutiveMessage({
    actor: 'ceo',
    body: 'unrelated message '.repeat(2000),
    message_type: 'update',
    created_at: '2026-10-03T12:00:00.000Z',
  });
  store.close();

  const response = await request(server, 'GET', '/api/executive/transcript?limit=1');
  assert.equal(response.status, 200);
  assert.equal(response.body.total_count, 2);
  assert.equal(response.body.has_more, true);
  assert.equal(response.body.messages.length, 1);
  assert.equal(response.body.messages[0].message_id, latest.message_id);
  assert.equal(response.body.messages[0].body_length, latest.body.length);
  assert.equal(response.body.messages[0].body.length, 1200);
  const olderPage = await request(
    server,
    'GET',
    `/api/executive/transcript?limit=1&before_at=${encodeURIComponent(latest.created_at)}&before_id=${latest.message_id}`
  );
  assert.equal(olderPage.body.messages[0].message_id, older.message_id);
  const fullText = await request(server, 'GET', `/api/executive/transcript/${latest.message_id}`);
  assert.equal(fullText.body.body, latest.body);
  assert.equal((await request(server, 'GET', '/api/executive/transcript/unrelated')).status, 404);
});
