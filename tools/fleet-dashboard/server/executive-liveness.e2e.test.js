'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const eventstore = require('./eventstore');
const { createApp } = require('./server');

test('HTTP liveness endpoint reports a stranded executive item end to end', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-liveness-e2e-'));
  const db = eventstore.open(root);
  const item = db.createExecutiveWorkItem({
    title: 'E2E stranded item',
    status: 'in_progress',
    owner: 'cto',
    lease_owner: 'worker-e2e',
    lease_expires_at: '2000-01-01T00:00:00.000Z',
  });
  db.close();

  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/executive/liveness',
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
        );
      }
    );
    request.on('error', reject);
    request.end();
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.schema, 'executive-liveness/v1');
  assert.equal(body.healthy, false);
  assert.equal(body.stranded[0].work_id, item.work_id);
  assert.equal(body.stranded[0].reason, 'lease_expired');
});
