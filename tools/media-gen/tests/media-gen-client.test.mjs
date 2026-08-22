import assert from 'node:assert/strict';
import test from 'node:test';

import { MediaGenClient } from '../client/media-gen-client.mjs';

test('default client falls back to loopback and remembers it', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    if (String(url).startsWith('http://host.docker.internal:4780')) {
      throw new TypeError('hostname unavailable');
    }
    return { json: async () => ({ ok: true }) };
  };

  try {
    const client = new MediaGenClient();
    assert.deepEqual(await client.health(), { ok: true });
    assert.deepEqual(await client.health(), { ok: true });
    assert.equal(client.baseUrl, 'http://127.0.0.1:4780');
    assert.deepEqual(requested, [
      'http://host.docker.internal:4780/health',
      'http://127.0.0.1:4780/health',
      'http://127.0.0.1:4780/health',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an explicit endpoint remains authoritative', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    throw new TypeError('unreachable');
  };

  try {
    const client = new MediaGenClient({ baseUrl: 'http://configured.example:4780/' });
    await assert.rejects(client.health(), /http:\/\/configured\.example:4780/);
    assert.deepEqual(requested, ['http://configured.example:4780/health']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP failures do not fall through to a different endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return { ok: false, status: 503, text: async () => 'backend unavailable' };
  };

  try {
    const client = new MediaGenClient();
    await assert.rejects(
      client.generate({ site: 'test', prompt: 'test' }),
      /503 from media-gen: backend unavailable/,
    );
    assert.deepEqual(requested, ['http://host.docker.internal:4780/generate']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
