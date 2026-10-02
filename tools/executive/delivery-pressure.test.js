'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assess, alert } = require('./delivery-pressure');

function fixture(now, requests = [], improvements = []) {
  const notifications = [];
  const store = {
    listChangeRequests: () => requests,
    listImprovements: () => improvements,
    getChangeQueueSettings: () => ({ enabled: true, max_concurrent: 6 }),
    listExecutiveActions: () => [
      { status: 'completed', finished_at: new Date(now - 5 * 60 * 1000).toISOString() },
    ],
    listExecutiveNotifications: () => notifications,
    createExecutiveNotification: row => {
      notifications.push(row);
      return row;
    },
  };
  return { store, notifications };
}

test('alerts domain-ops once when the executive pipeline is empty', async () => {
  const now = Date.parse('2026-10-02T20:00:00Z');
  const { store, notifications } = fixture(now);
  let posts = 0;
  const options = {
    now,
    env: { SLACK_BOT_TOKEN: 'test-token' },
    fetchImpl: async (_url, request) => {
      posts += 1;
      const body = JSON.parse(request.body);
      assert.equal(body.channel, 'domain-ops');
      assert.match(body.text, /no eligible or active delivery work/);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
  const first = await alert(store, '/missing', options);
  const second = await alert(store, '/missing', options);
  assert.equal(first.sent, true);
  assert.equal(second.skipped, 'already-alerted');
  assert.equal(posts, 1);
  assert.equal(notifications.length, 1);
});

test('stale eligible work triggers pressure even if another delivery was recent', () => {
  const now = Date.parse('2026-10-02T20:00:00Z');
  const { store } = fixture(now, [
    {
      request_id: 'old-eligible',
      site: 'example.com',
      status: 'queued',
      delivery_mode: 'direct',
      category: 'seo',
      title: 'Ship a bounded change',
      created_at: '2026-10-02T19:00:00Z',
    },
    {
      request_id: 'delivered',
      site: 'other.example.com',
      status: 'deployed',
      delivery_mode: 'direct',
      title: 'Already shipped',
      updated_at: '2026-10-02T19:50:00Z',
    },
  ]);
  assert.match(assess(store, '/missing', now).reason, /unclaimed work older than 30 minutes/);
});
