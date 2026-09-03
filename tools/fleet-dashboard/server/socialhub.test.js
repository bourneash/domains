'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const socialhub = require('./socialhub');

test('calendar proxies the authoritative hub schedule with a bounded horizon', async t => {
  const originalFetch = global.fetch;
  let requested = '';
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async url => {
    requested = String(url);
    return {
      ok: true,
      text: async () =>
        JSON.stringify({ posts: [{ id: 7, scheduled_at: '2026-08-27T12:00:00Z' }] }),
    };
  };

  const result = await socialhub.calendar('alpha.example', 90);

  assert.deepEqual(
    result.posts.map(post => post.id),
    [7]
  );
  assert.match(requested, /\/api\/calendar\?site=alpha\.example&days=31$/);
});

test('calendar defaults invalid horizons to seven days and safely encodes the site', async t => {
  const originalFetch = global.fetch;
  let requested = '';
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async url => {
    requested = String(url);
    return { ok: true, text: async () => '{"posts":[]}' };
  };

  await socialhub.calendar('a&b.example', 'not-a-number');

  assert.match(requested, /\/api\/calendar\?site=a%26b\.example&days=7$/);
});

test('createPost composes through the hub and applies an exact schedule when supplied', async t => {
  const originalFetch = global.fetch;
  const requests = [];
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const post = requests.length === 1
      ? { id: 42, status: 'scheduled', scheduled_at: '2026-08-31T12:00:00Z' }
      : { id: 42, status: 'scheduled', scheduled_at: '2026-09-01T15:30:00Z' };
    return { ok: true, text: async () => JSON.stringify(post) };
  };

  const result = await socialhub.createPost({
    site: 'alpha.example',
    platform: 'bluesky',
    body: 'A hand-written update',
    schedule: true,
    scheduled_at: '2026-09-01T15:30:00Z',
  });

  assert.equal(result.scheduled_at, '2026-09-01T15:30:00Z');
  assert.match(requests[0].url, /\/api\/posts$/);
  assert.match(requests[1].url, /\/api\/posts\/42$/);
  assert.equal(JSON.parse(requests[0].options.body).author, 'fleet-dashboard');
});
