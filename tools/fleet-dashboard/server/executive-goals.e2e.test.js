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
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('HTTP goal hierarchy and work lineage survive a real API round trip', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-goals-e2e-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const goalResponse = await request(server, 'POST', '/api/executive/goals', {
    title: 'Portfolio value',
    statement: 'Improve attributable outcomes across the fleet.',
    owner: 'ceo',
  });
  assert.equal(goalResponse.status, 201);
  const goal = goalResponse.body.goal;
  const workResponse = await request(server, 'POST', '/api/executive/work-items', {
    title: 'Measure one improvement',
    kind: 'evidence',
    owner: 'cto',
    goal_id: goal.goal_id,
  });
  assert.equal(workResponse.status, 201);
  assert.equal(workResponse.body.work_item.goal_id, goal.goal_id);

  const detail = await request(server, 'GET', `/api/executive/goals/${goal.goal_id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.goal.goal_id, goal.goal_id);
  assert.equal(detail.body.work_items[0].work_id, workResponse.body.work_item.work_id);

  const cycle = await request(server, 'PATCH', `/api/executive/goals/${goal.goal_id}`, {
    parent_goal_id: goal.goal_id,
  });
  assert.equal(cycle.status, 409);
});
