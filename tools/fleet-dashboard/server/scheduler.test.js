'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { register, makeClient, ROUTES } = require('./scheduler');

// A fake fleet-scheduler that records what it was asked and can be told to misbehave.
function fakeUpstream(handler) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }));
  });
}

async function withApp(upstreamHandler, env, fn) {
  const up = await fakeUpstream(upstreamHandler);
  const app = express();
  app.use(express.json());
  register(app, {
    call: makeClient({ FLEET_SCHEDULER_URL: `http://127.0.0.1:${up.port}`, ...env }),
  });
  const srv = await new Promise(r => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    return await fn({ base, seen: up.seen });
  } finally {
    srv.close();
    up.srv.close();
  }
}
const ok = (_q, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
};

test('forwards allowed routes with bearer token + actor, never leaks token to client', async () => {
  await withApp(ok, { FLEET_SCHEDULER_TOKEN: 'x'.repeat(30) }, async ({ base, seen }) => {
    const r = await fetch(`${base}/api/scheduler/jobs?site=a.com`);
    assert.equal(r.status, 200);
    assert.equal(seen[0].url, '/api/jobs?site=a.com');
    assert.equal(seen[0].headers.authorization, 'Bearer ' + 'x'.repeat(30));
    assert.equal(seen[0].headers['x-actor'], 'fleet-dashboard');
    assert.ok(!JSON.stringify([...r.headers]).includes('xxxxxxxx'));
  });
});

test('forwards JSON bodies for PATCH/POST', async () => {
  await withApp(ok, { FLEET_SCHEDULER_TOKEN: 't'.repeat(30) }, async ({ base, seen }) => {
    await fetch(`${base}/api/scheduler/jobs/12`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(seen[0].method, 'PATCH');
    assert.deepEqual(JSON.parse(seen[0].body), { enabled: false });
  });
});

test('non-allowlisted paths and methods are 404 and never reach the scheduler', async () => {
  await withApp(ok, { FLEET_SCHEDULER_TOKEN: 't'.repeat(30) }, async ({ base, seen }) => {
    for (const [m, p] of [
      ['GET', 'reload'],
      ['POST', 'reload'],
      ['DELETE', 'settings'],
      ['GET', 'jobs/abc'],
      ['POST', 'jobs/1/run/extra'],
      ['GET', '../healthz'],
      ['POST', 'sites/x.com/nuke'],
      ['PUT', 'jobs'],
    ]) {
      const r = await fetch(`${base}/api/scheduler/${p}`, { method: m });
      assert.equal(r.status, 404, `${m} ${p}`);
    }
    assert.equal(seen.length, 0);
  });
});

test('upstream status and error bodies pass through', async () => {
  await withApp(
    (_q, res) => {
      res.statusCode = 409;
      res.end('{"error":"job already queued or running"}');
    },
    { FLEET_SCHEDULER_TOKEN: 't'.repeat(30) },
    async ({ base }) => {
      const r = await fetch(`${base}/api/scheduler/jobs/3/run`, { method: 'POST' });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).error, 'job already queued or running');
    }
  );
});

test('missing token -> 503 without contacting upstream', async () => {
  await withApp(ok, {}, async ({ base, seen }) => {
    const r = await fetch(`${base}/api/scheduler/status`);
    assert.equal(r.status, 503);
    assert.equal(seen.length, 0);
  });
});

test('unreachable scheduler -> 502 with a clear message', async () => {
  const app = express();
  register(app, {
    call: makeClient({
      FLEET_SCHEDULER_URL: 'http://127.0.0.1:1',
      FLEET_SCHEDULER_TOKEN: 't'.repeat(30),
    }),
  });
  const srv = await new Promise(r => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/scheduler/status`);
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /unreachable/);
  } finally {
    srv.close();
  }
});

test('route table covers exactly the scheduler API surface the UI needs', () => {
  assert.ok(ROUTES.length >= 12);
  assert.ok(!ROUTES.some(([, re]) => re.test('reload')));
});
