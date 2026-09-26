'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createApp } = require('./server');

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: pathname },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test(
  'agents UI/API expose one editorial family with exact profile dispatch',
  { skip: process.env.FD_RUN_NETWORK_E2E !== '1' },
  async t => {
    const app = createApp();
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));

    const page = await request(server, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /app\.js/);

    const response = await request(server, '/api/agents');
    assert.equal(response.status, 200);
    const agents = JSON.parse(response.body);
    const family = agents.find(agent => agent.role === 'update');
    assert.ok(family);
    assert.ok(family.sites >= 3);
    assert.ok(family.profiles.includes('news-writer-local'));
    assert.ok(family.profiles.includes('breaking-news'));
    assert.ok(family.profiles.includes('weekly-editorial'));
    assert.equal(
      agents.some(agent => agent.role === 'content-writer'),
      false
    );
    assert.equal(
      agents.some(agent => agent.role === 'news-writer'),
      false
    );
  }
);
