'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dhi = require('./datahub-images');

test('sources() builds the correct URL and returns the upstream body verbatim', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ sources: [{ id: 'src1' }] }) };
  };
  const result = await dhi.sources();
  assert.equal(calledUrl, `${dhi.API}/sources`);
  assert.deepEqual(result, { sources: [{ id: 'src1' }] });
});

test('sources() returns a degraded {ok:false, sources:[]} when fetch rejects', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const result = await dhi.sources();
  assert.equal(result.ok, false);
  assert.deepEqual(result.sources, []);
  assert.match(result.error, /ECONNREFUSED/);
});

test('egress(limit) builds the querystring and degrades to {events:[]}', async () => {
  let calledUrl = null;
  global.fetch = async (url) => { calledUrl = url; throw new Error('down'); };
  const result = await dhi.egress(80);
  assert.equal(calledUrl, `${dhi.API}/egress?limit=80`);
  assert.deepEqual(result.events, []);
});

test('pulls(limit) builds the querystring and degrades to {pulls:[]}', async () => {
  let calledUrl = null;
  global.fetch = async (url) => { calledUrl = url; throw new Error('down'); };
  const result = await dhi.pulls(80);
  assert.equal(calledUrl, `${dhi.API}/pulls?limit=80`);
  assert.deepEqual(result.pulls, []);
});

test('stats() degrades to an all-empty-object shape on failure', async () => {
  global.fetch = async () => { throw new Error('down'); };
  const result = await dhi.stats();
  assert.equal(result.ok, false);
  assert.deepEqual(result.pool_by_topic, {});
  assert.deepEqual(result.pool_by_source, {});
  assert.deepEqual(result.pool_by_license, {});
  assert.deepEqual(result.requests_by_status, {});
});

test('images(params) builds a query string from topic/site/status/limit, in that order', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ images: [] }) };
  };
  await dhi.images({ topic: 'iran', site: 'americastrikes.com', status: 'active', limit: 50 });
  assert.equal(calledUrl, `${dhi.API}/images?topic=iran&site=americastrikes.com&status=active&limit=50`);
});

test('images() with no params omits the querystring entirely', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ images: [] }) };
  };
  await dhi.images();
  assert.equal(calledUrl, `${dhi.API}/images`);
});

test('setSourceEnabled(id, enabled) POSTs the enabled flag as JSON', async () => {
  let calledUrl = null, calledOpt = null;
  global.fetch = async (url, opt) => {
    calledUrl = url; calledOpt = opt;
    return { ok: true, status: 200, json: async () => ({ id: 'src1', enabled: true }) };
  };
  await dhi.setSourceEnabled('src1', true);
  assert.equal(calledUrl, `${dhi.API}/sources/src1/enabled`);
  assert.equal(calledOpt.method, 'POST');
  assert.deepEqual(JSON.parse(calledOpt.body), { enabled: true });
});

test('setSourceEnabled() returns {ok:false} when fetch rejects', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const result = await dhi.setSourceEnabled('src1', false);
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test('blacklistImage(id) POSTs with no body', async () => {
  let calledUrl = null, calledMethod = null;
  global.fetch = async (url, opt) => {
    calledUrl = url; calledMethod = opt.method;
    return { ok: true, status: 200, json: async () => ({ id: 'img1', status: 'blacklisted' }) };
  };
  const result = await dhi.blacklistImage('img1');
  assert.equal(calledUrl, `${dhi.API}/images/img1/blacklist`);
  assert.equal(calledMethod, 'POST');
  assert.deepEqual(result, { id: 'img1', status: 'blacklisted' });
});

test('rejectImage(id) POSTs with no body', async () => {
  let calledUrl = null, calledMethod = null;
  global.fetch = async (url, opt) => {
    calledUrl = url; calledMethod = opt.method;
    return { ok: true, status: 200, json: async () => ({ id: 'img1', status: 'deleted' }) };
  };
  const result = await dhi.rejectImage('img1');
  assert.equal(calledUrl, `${dhi.API}/images/img1/reject`);
  assert.equal(calledMethod, 'POST');
  assert.deepEqual(result, { id: 'img1', status: 'deleted' });
});

test('imageBytes(id) returns the buffer + upstream content-type on success', async () => {
  global.fetch = async (url) => {
    assert.equal(url, `${dhi.API}/image/abc123`);
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? 'image/webp' : null) },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  const r = await dhi.imageBytes('abc123');
  assert.equal(r.ok, true);
  assert.equal(r.contentType, 'image/webp');
  assert.deepEqual([...r.buffer], [1, 2, 3]);
});

test('imageBytes(id) returns {ok:false} when the upstream 404s', async () => {
  global.fetch = async () => ({ ok: false, status: 404 });
  const r = await dhi.imageBytes('missing');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('imageBytes(id) returns {ok:false} when fetch rejects (upstream unreachable)', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  const r = await dhi.imageBytes('missing');
  assert.equal(r.ok, false);
  assert.match(r.error, /network down/);
});
