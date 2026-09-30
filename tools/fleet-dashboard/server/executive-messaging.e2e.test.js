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
    assert.equal(tracked.messages.length, 3);
    assert.equal(tracked.messages[2].actor, 'ceo');
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

    const thread = await request(
      server,
      'GET',
      `/api/executive/messages?work_id=${workId}&limit=10`
    );
    assert.equal(thread.status, 200);
    assert.equal(thread.body.messages.length, 4);
    assert.equal(thread.body.messages.at(-1).actor, 'owner');
  } catch (error) {
    console.error('executive messaging E2E failure:', error);
    throw error;
  }
});
