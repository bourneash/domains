'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { alertConsecutiveFailures } = require('./overwatch-alert');

function fixture(statuses) {
  const runs = statuses.map((status, index) => ({
    run_id: `run-${index}`,
    status,
    result: {},
    error: 'preflight failed',
  }));
  const store = {
    listAgentRuns: () => runs,
    getAgentRun: id => runs.find(run => run.run_id === id),
    updateAgentRun: (id, patch) =>
      Object.assign(
        runs.find(run => run.run_id === id),
        patch
      ),
  };
  return { runs, store, agent: { agent_id: 'overwatch' } };
}

test('alerts on the second consecutive failure, not the first', async () => {
  const first = fixture(['failed', 'succeeded']);
  const ignored = await alertConsecutiveFailures(first.store, {
    agent: first.agent,
    runId: 'run-0',
    root: '/missing',
    env: {},
  });
  assert.equal(ignored.attempted, false);
  const second = fixture(['failed', 'failed', 'succeeded']);
  let posts = 0;
  const alerted = await alertConsecutiveFailures(second.store, {
    agent: second.agent,
    runId: 'run-0',
    root: '/missing',
    env: { SLACK_BOT_TOKEN: 'test-token', SLACK_CHANNEL_FLEET: '#test' },
    fetchImpl: async (_url, options) => {
      posts++;
      assert.match(JSON.parse(options.body).text, /2 consecutive runs/);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(posts, 1);
  assert.equal(alerted.sent, true);
  assert.equal(second.runs[0].result.overwatch_alert.sent, true);
});

test('does not repeat a delivered alert, but retries a failed Slack post', async () => {
  const { runs, store, agent } = fixture(['failed', 'failed', 'failed']);
  runs[1].result.overwatch_alert = { sent: true };
  const skipped = await alertConsecutiveFailures(store, {
    agent,
    runId: 'run-0',
    root: '/missing',
    env: {},
  });
  assert.equal(skipped.reason, 'already-alerted');
  delete runs[1].result.overwatch_alert;
  const failed = await alertConsecutiveFailures(store, {
    agent,
    runId: 'run-0',
    root: '/missing',
    env: { SLACK_BOT_TOKEN: 'test-token', SLACK_CHANNEL_FLEET: '#test' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    }),
  });
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, 'channel_not_found');
});

test('keeps the alert pending when no fleet channel is configured', async () => {
  const { store, agent } = fixture(['failed', 'failed']);
  const notifications = [];
  store.createExecutiveNotification = input => notifications.push(input);
  const result = await alertConsecutiveFailures(store, {
    agent,
    runId: 'run-0',
    root: '/missing',
    env: { SLACK_BOT_TOKEN: 'test-token' },
    fetchImpl: () => {
      throw new Error('must not post');
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'fleet Slack channel not configured');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].dedupe_key, 'overwatch-failure:run-1');
});

test('also alerts on two consecutive executive runner failures', async () => {
  const { runs, store, agent } = fixture(['failed', 'failed', 'succeeded']);
  const notifications = [];
  store.createExecutiveNotification = input => notifications.push(input);
  const result = await alertConsecutiveFailures(store, {
    agent,
    runId: 'run-0',
    root: '/missing',
    label: 'Executive team',
    resultKey: 'executive_failure_alert',
    notificationType: 'executive-run-failure',
    env: { SLACK_BOT_TOKEN: 'test-token', SLACK_CHANNEL_FLEET: '#test' },
    fetchImpl: async (_url, options) => {
      assert.match(JSON.parse(options.body).text, /Executive team failed 2 consecutive runs/);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(runs[0].result.executive_failure_alert.sent, true);
  assert.equal(notifications[0].notification_type, 'executive-run-failure');
});
