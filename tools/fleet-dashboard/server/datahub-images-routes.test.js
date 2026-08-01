'use strict';

// Self-protecting even when this file is run directly (`node --test <file>`):
// force the test env BEFORE requiring ./server so createApp() never starts the
// deploy-health poller, whose live Cloudflare fetch would otherwise clobber the
// per-test global.fetch stub (B1). The npm `test` script also sets this.
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createApp } = require('./server');

// Talk to the test server over raw node:http so global.fetch stays free for
// stubbing the OUTBOUND call our own routes make to the upstream
// data-hub-images service — using fetch for both ends would collide.
function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startServer(app, t) {
  // Bind explicitly to loopback and wait for the asynchronous listen to
  // complete before reading server.address(). This keeps the suite compatible
  // with restricted CI sandboxes and removes a race that could return null.
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test('GET /api/datahub-images/sources returns degraded 200 JSON when upstream is down', async (t) => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'GET', '/api/datahub-images/sources');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.buffer.toString('utf8'));
  assert.equal(body.ok, false);
  assert.deepEqual(body.sources, []);
});

test('GET /api/datahub-images/health returns degraded 200 JSON when upstream is down', async (t) => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'GET', '/api/datahub-images/health');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.buffer.toString('utf8'));
  assert.equal(body.ok, false);
});

test('GET /api/datahub-images/images passes topic/site/status/limit through to the upstream call', async (t) => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ images: [{ id: 'img1' }] }) };
  };
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'GET', '/api/datahub-images/images?topic=iran&site=americastrikes.com&status=active&limit=25');
  assert.equal(res.status, 200);
  assert.match(calledUrl, /\/images\?topic=iran&site=americastrikes\.com&status=active&limit=25$/);
  const body = JSON.parse(res.buffer.toString('utf8'));
  assert.deepEqual(body.images, [{ id: 'img1' }]);
});

test('POST /api/datahub-images/images/:id/blacklist forwards to blacklistImage', async (t) => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ id: 'img1', status: 'blacklisted' }) };
  };
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'POST', '/api/datahub-images/images/img1/blacklist');
  assert.equal(res.status, 200);
  assert.match(calledUrl, /\/images\/img1\/blacklist$/);
  const body = JSON.parse(res.buffer.toString('utf8'));
  assert.deepEqual(body, { id: 'img1', status: 'blacklisted' });
});

test('GET /api/datahub-images/image/:id streams bytes with the upstream content-type', async (t) => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'image/webp' : null) },
    arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
  });
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'GET', '/api/datahub-images/image/abc');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.deepEqual([...res.buffer], [9, 9, 9]);
});

test('GET /api/datahub-images/image/:id returns 404 JSON when the upstream is unreachable', async (t) => {
  global.fetch = async () => { throw new Error('down'); };
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'GET', '/api/datahub-images/image/abc');
  assert.equal(res.status, 404);
  const body = JSON.parse(res.buffer.toString('utf8'));
  assert.deepEqual(body, { error: 'image unavailable' });
});

test('GET /api/datahub-images/image/:id validates content-type and sets nosniff header', async (t) => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'GET', '/api/datahub-images/image/xyz');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual([...res.buffer], [1, 2, 3]);
});

test('GET /api/datahub-images/image/:id preserves image/* content-type and sets nosniff header', async (t) => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'image/webp' : null) },
    arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
  });
  const app = createApp();
  const server = await startServer(app, t);
  const res = await request(server, 'GET', '/api/datahub-images/image/abc');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual([...res.buffer], [9, 9, 9]);
});
