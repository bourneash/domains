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
