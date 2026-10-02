'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { config, alertConsecutiveFailures } = require('./overwatch-alert');

test('uses the existing domain-ops channel unless explicitly overridden', () => {
  assert.equal(config('/missing', { SLACK_BOT_TOKEN: 'test-token' }).channel, 'domain-ops');
  assert.equal(
    config('/missing', { EXEC_ALERT_CHANNEL: 'custom-ops', SLACK_CHANNEL_FLEET: '#fleet-ops' })
      .channel,
    'custom-ops'
  );
});

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
    env: { SLACK_BOT_TOKEN: 'test-token' },
    fetchImpl: async (_url, options) => {
      posts++;
      assert.equal(JSON.parse(options.body).channel, 'domain-ops');
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
    env: { SLACK_BOT_TOKEN: 'test-token' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    }),
  });
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, 'channel_not_found');
});

test('keeps the alert pending when the bot token is unavailable', async () => {
  const { store, agent } = fixture(['failed', 'failed']);
  const notifications = [];
  store.createExecutiveNotification = input => notifications.push(input);
  const result = await alertConsecutiveFailures(store, {
    agent,
    runId: 'run-0',
    root: '/missing',
    env: {},
    fetchImpl: () => {
      throw new Error('must not post');
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'SLACK_BOT_TOKEN unavailable');
  assert.equal(result.channel, 'domain-ops');
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
    env: { SLACK_BOT_TOKEN: 'test-token' },
    fetchImpl: async (_url, options) => {
      assert.match(JSON.parse(options.body).text, /Executive team failed 2 consecutive runs/);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(runs[0].result.executive_failure_alert.sent, true);
  assert.equal(notifications[0].notification_type, 'executive-run-failure');
});
