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
const roles = require('./roles');
const aiusage = require('./aiusage');

function request(server) {
  return new Promise((resolve, reject) => {
    http.get(
      `http://127.0.0.1:${server.address().port}/api/agents/engineer/health?compact=1`,
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
        );
      }
    ).on('error', reject);
  });
}

test('agent health shares a fresh report across requests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-cache-'));
  const oldFleet = aiusage.fleet;
  const oldMatrix = roles.agentMatrix;
  const oldHealth = roles.health;
  let usageCalls = 0;
  let matrixCalls = 0;
  let healthCalls = 0;
  aiusage.fleet = async () => {
    usageCalls++;
    return { by_site_role: [] };
  };
  roles.agentMatrix = async () => {
    matrixCalls++;
    return { sites: [] };
  };
  roles.health = async () => {
    healthCalls++;
    return { role: 'engineer', summary: { enrolled: 0 }, rows: [] };
  };
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    aiusage.fleet = oldFleet;
    roles.agentMatrix = oldMatrix;
    roles.health = oldHealth;
    fs.rmSync(root, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  });

  const first = await request(server);
  const second = await request(server);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(usageCalls, 1);
  assert.equal(matrixCalls, 1);
  assert.equal(healthCalls, 1);
});
