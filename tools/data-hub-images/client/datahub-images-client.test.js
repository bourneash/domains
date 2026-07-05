// Tests for datahub-images-client. Network-free: spins a local node:http stub
// that mimics the broker's /request, /request/{id}, /image/{id}, /images,
// /health endpoints. No real broker, no VPN, no external calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DataHubImagesClient, DataHubImagesError, normalizeKeywords } from './datahub-images-client.mjs';

// A 1x1 JPEG-ish byte blob (content-type is what the client checks, not validity).
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/**
 * Start a stub broker. `handlers` maps "METHOD /path-prefix" → (req,res,ctx)=>void.
 * Returns { baseUrl, close, calls } where calls records every request.
 */
async function startStub(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks).toString('utf8');
      const url = new URL(req.url, 'http://localhost');
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body: rawBody });
      // Longest-prefix match on "METHOD /path".
      const key = `${req.method} ${url.pathname}`;
      let handler = routes[key];
      if (!handler) {
        for (const [k, h] of Object.entries(routes)) {
          const [m, p] = k.split(' ');
          if (m === req.method && url.pathname.startsWith(p) && p.endsWith('/')) { handler = h; break; }
        }
      }
      if (!handler) { res.writeHead(404); res.end('no route'); return; }
      handler(req, res, { url, body: rawBody ? JSON.parse(rawBody) : undefined, calls });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

test('normalizeKeywords: array, comma string, space string, junk', () => {
  assert.deepEqual(normalizeKeywords(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(normalizeKeywords('a, b,c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeKeywords('mount fuji'), ['mount', 'fuji']);
  assert.deepEqual(normalizeKeywords(undefined), []);
  assert.deepEqual(normalizeKeywords(42), []);
});

test('request: sync happy path returns broker JSON verbatim', async () => {
  const stub = await startStub({
    'POST /request': (req, res, { body }) => {
      assert.equal(body.site, 'demo');
      assert.deepEqual(body.keywords, ['ocean', 'waves']);
      assert.equal(body.count, 2);
      json(res, { images: [{ id: 'abc', url: '/image/abc', credit: { source: 'Unsplash' }, width: 10, height: 5 }] });
    },
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl });
    const r = await c.request({ site: 'demo', keywords: 'ocean, waves', count: 2 });
    assert.equal(r.images[0].id, 'abc');
  } finally { await stub.close(); }
});

test('request: async passes JSON key "async":true (not async_)', async () => {
  const stub = await startStub({
    'POST /request': (req, res, { body }) => {
      assert.equal(body.async, true);
      assert.equal('async_' in body, false);
      json(res, { status: 'pending', request_id: 7 });
    },
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl });
    const r = await c.request({ site: 'demo', keywords: ['x'], async_: true });
    assert.equal(r.request_id, 7);
  } finally { await stub.close(); }
});

test('request: arg validation throws before any network call', async () => {
  const c = new DataHubImagesClient({ baseUrl: 'http://127.0.0.1:1', fetch: () => { throw new Error('should not fetch'); } });
  await assert.rejects(() => c.request({ keywords: ['x'] }), /site.*required/);
  await assert.rejects(() => c.request({ site: 'd' }), /keywords.*or a registered.*topic/);
  await assert.rejects(() => c.request({ site: 'd', keywords: ['x'], count: 0 }), /positive integer/);
});

test('sourceImage: sync hit downloads bytes and returns credit + path', async () => {
  const stub = await startStub({
    'POST /request': (req, res) => json(res, {
      images: [{ id: 'img1', url: '/image/img1', credit: { source: 'Pexels', photographer: 'Jo' }, width: 800, height: 600 }],
    }),
    'GET /image/': (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(FAKE_JPEG); },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dhi-cli-'));
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl });
    const r = await c.sourceImage({ site: 'demo', keywords: ['x'], destDir: dir });
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].credit.source, 'Pexels');
    assert.equal(r.images[0].bytes, FAKE_JPEG.length);
    const onDisk = await fs.readFile(r.images[0].path);
    assert.deepEqual(onDisk, FAKE_JPEG);
  } finally { await stub.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('sourceImage: empty miss returns [] with note, never throws', async () => {
  const stub = await startStub({
    'POST /request': (req, res) => json(res, { images: [], note: 'no fetchable image' }),
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl, retries: 0 });
    const r = await c.sourceImage({ site: 'demo', keywords: ['nothing'] });
    assert.deepEqual(r.images, []);
    assert.match(r.note, /no fetchable/);
  } finally { await stub.close(); }
});

test('sourceImage: retries on busy note, then succeeds', async () => {
  let n = 0;
  const stub = await startStub({
    'POST /request': (req, res) => {
      n++;
      if (n === 1) return json(res, { images: [], note: 'broker busy — no free fetch slot; retry or use async' });
      json(res, { images: [{ id: 'ok', url: '/image/ok', width: 1, height: 1 }] });
    },
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl, retries: 2, _sleep: () => Promise.resolve() });
    const r = await c.sourceImage({ site: 'demo', keywords: ['x'] });
    assert.equal(n, 2);
    assert.equal(r.images[0].id, 'ok');
  } finally { await stub.close(); }
});

test('sourceImage: retries on 5xx transport error, then succeeds', async () => {
  let n = 0;
  const stub = await startStub({
    'POST /request': (req, res) => {
      n++;
      if (n === 1) { res.writeHead(503); res.end('unavailable'); return; }
      json(res, { images: [{ id: 'ok2', url: '/image/ok2', width: 1, height: 1 }] });
    },
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl, retries: 2, _sleep: () => Promise.resolve() });
    const r = await c.sourceImage({ site: 'demo', keywords: ['x'] });
    assert.equal(n, 2);
    assert.equal(r.images[0].id, 'ok2');
  } finally { await stub.close(); }
});

test('sourceImage: 4xx transport error is NOT retried and throws', async () => {
  let n = 0;
  const stub = await startStub({
    'POST /request': (req, res) => { n++; res.writeHead(400); res.end('bad'); },
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl, retries: 3, _sleep: () => Promise.resolve() });
    await assert.rejects(() => c.sourceImage({ site: 'demo', keywords: ['x'] }), DataHubImagesError);
    assert.equal(n, 1); // no retry on 400
  } finally { await stub.close(); }
});

test('sourceImage async: poll → done → enrich credit → download', async () => {
  let polls = 0;
  const stub = await startStub({
    'POST /request': (req, res) => json(res, { status: 'pending', request_id: 42 }),
    'GET /request/42': (req, res) => {
      polls++;
      if (polls < 2) return json(res, { status: 'pending', result: { image_ids: [] } });
      json(res, { status: 'done', result: { image_ids: ['zz'] } });
    },
    'GET /images': (req, res) => json(res, { images: [{ id: 'zz', credit: { source: 'Wikimedia' }, width: 3, height: 2 }] }),
    'GET /image/': (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(FAKE_JPEG); },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dhi-async-'));
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl, _sleep: () => Promise.resolve() });
    const r = await c.sourceImage({ site: 'demo', keywords: ['x'], async_: true, destDir: dir, waitOpts: { intervalMs: 1 } });
    assert.equal(r.requestId, 42);
    assert.equal(r.images[0].id, 'zz');
    assert.equal(r.images[0].credit.source, 'Wikimedia');
    assert.ok(r.images[0].path);
  } finally { await stub.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('sourceImage async: failed request returns [] with note', async () => {
  const stub = await startStub({
    'POST /request': (req, res) => json(res, { status: 'pending', request_id: 5 }),
    'GET /request/5': (req, res) => json(res, { status: 'failed', note: null, result: { image_ids: [], note: 'unknown topic' } }),
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl, _sleep: () => Promise.resolve() });
    const r = await c.sourceImage({ site: 'demo', topic: 'nope', async_: true });
    assert.deepEqual(r.images, []);
    assert.match(r.note, /unknown topic/);
  } finally { await stub.close(); }
});

test('getImageBuffer: rejects non-image content-type', async () => {
  const stub = await startStub({
    'GET /image/': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>nope</h1>'); },
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl });
    await assert.rejects(() => c.getImageBuffer('x'), /non-image content-type/);
  } finally { await stub.close(); }
});

test('downloadImage: creates missing parent directories', async () => {
  const stub = await startStub({
    'GET /image/': (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(FAKE_JPEG); },
  });
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dhi-mkdir-'));
  const dest = path.join(base, 'a', 'b', 'c', 'out.png');
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl });
    const r = await c.downloadImage('id', dest);
    assert.equal(r.bytes, FAKE_JPEG.length);
    assert.equal(r.contentType, 'image/png');
    await fs.access(dest);
  } finally { await stub.close(); await fs.rm(base, { recursive: true, force: true }); }
});

test('timeout surfaces as DataHubImagesError', async () => {
  const stub = await startStub({
    'GET /health': (req, res) => { /* never respond */ },
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl, metaTimeoutMs: 40 });
    await assert.rejects(() => c.health(), /timed out/);
  } finally { await stub.close(); }
});

test('health/stats/sources passthrough', async () => {
  const stub = await startStub({
    'GET /health': (req, res) => json(res, { ok: true, vpn: { us: '1.2.3.4' } }),
  });
  try {
    const c = new DataHubImagesClient({ baseUrl: stub.baseUrl });
    const h = await c.health();
    assert.equal(h.ok, true);
  } finally { await stub.close(); }
});
