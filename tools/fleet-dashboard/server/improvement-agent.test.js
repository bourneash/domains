'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('./improvement-agent');

test('provider executable defaults match the configured queue providers', () => {
  assert.equal(agent.providerExecutable('claude'), 'claude');
  assert.equal(agent.providerExecutable('chatgpt'), 'codex');
  assert.equal(agent.providerExecutable('local'), 'ollama');
});

test('queue workers default to the project Codex model and rebind unauthenticated Claude work', () => {
  const provider = process.env.FD_CHANGE_QUEUE_PROVIDER;
  const model = process.env.FD_CHANGE_QUEUE_MODEL;
  const allowClaude = process.env.FD_CHANGE_QUEUE_ALLOW_CLAUDE;
  delete process.env.FD_CHANGE_QUEUE_PROVIDER;
  delete process.env.FD_CHANGE_QUEUE_MODEL;
  delete process.env.FD_CHANGE_QUEUE_ALLOW_CLAUDE;
  try {
    assert.equal(agent.defaultProvider(), 'chatgpt');
    assert.equal(agent.defaultModel(), 'gpt-5.6-luna');
    assert.deepEqual(agent.resolveWorkerProvider({ provider: 'claude', model: 'claude-sonnet' }), {
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      fallback: true,
      reason: 'claude worker auth is disabled in the fleet dashboard',
    });
    assert.deepEqual(agent.resolveWorkerProvider({ provider: 'chatgpt' }), {
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      fallback: false,
    });
  } finally {
    if (provider === undefined) delete process.env.FD_CHANGE_QUEUE_PROVIDER;
    else process.env.FD_CHANGE_QUEUE_PROVIDER = provider;
    if (model === undefined) delete process.env.FD_CHANGE_QUEUE_MODEL;
    else process.env.FD_CHANGE_QUEUE_MODEL = model;
    if (allowClaude === undefined) delete process.env.FD_CHANGE_QUEUE_ALLOW_CLAUDE;
    else process.env.FD_CHANGE_QUEUE_ALLOW_CLAUDE = allowClaude;
  }
});

test('worker liveness accepts the portable docker top command output', () => {
  assert.equal(
    agent.processListHasWorker(
      'PID PPID ELAPSED %CPU COMMAND\n123 1 00:10 2.0 node /usr/bin/codex exec --model gpt-5.6-luna'
    ),
    true
  );
  assert.equal(
    agent.processListHasWorker(
      'PID PPID ELAPSED %CPU COMMAND\n123 1 00:10 0.0 /usr/bin/tini -- /usr/local/bin/dd-entrypoint'
    ),
    false
  );
});

test('worker startup grace protects a durable running row during provider reattach', () => {
  const startedAt = Date.now() - 1000;
  assert.equal(
    agent.workerStartupGraceActive({
      agent: { status: 'running', started_at: new Date(startedAt).toISOString() },
    }),
    true
  );
  assert.equal(
    agent.workerStartupGraceActive({
      agent: {
        status: 'running',
        started_at: new Date(Date.now() - agent.WORKER_START_GRACE_MS - 1000).toISOString(),
      },
    }),
    false
  );
  assert.equal(
    agent.workerStartupGraceActive({
      agent: { status: 'completed', started_at: new Date().toISOString() },
    }),
    false
  );
});

test('provider preflight rejects missing sandbox and unsafe command values', async () => {
  assert.throws(() => agent.preflight({ run: {}, provider: 'chatgpt' }), /sandbox is required/);
  const previous = process.env.FD_CHANGE_QUEUE_CHATGPT_COMMAND;
  process.env.FD_CHANGE_QUEUE_CHATGPT_COMMAND = 'codex;rm';
  try {
    await assert.rejects(
      agent.preflight({ run: { sandbox: { container: 'dd-test' } }, provider: 'chatgpt' }),
      error => error.httpStatus === 400 && /single executable/.test(error.message)
    );
  } finally {
    if (previous === undefined) delete process.env.FD_CHANGE_QUEUE_CHATGPT_COMMAND;
    else process.env.FD_CHANGE_QUEUE_CHATGPT_COMMAND = previous;
  }
});

test('review result requires an explicit PASS marker', () => {
  assert.deepEqual(agent.reviewResult('looks good\nFD_REVIEW_RESULT: PASS'), {
    approved: true,
    marker: 'PASS',
  });
  assert.deepEqual(agent.reviewResult('FD_REVIEW_RESULT: FAIL'), {
    approved: false,
    marker: 'FAIL',
  });
  assert.deepEqual(agent.reviewResult('looks good, no marker'), { approved: false, marker: null });
  assert.deepEqual(
    agent.reviewResult('prior run\nFD_REVIEW_RESULT: PASS\ncurrent run\nFD_REVIEW_RESULT: FAIL'),
    { approved: false, marker: 'FAIL' }
  );
});

test('agent log writes ignore chunks after the stream has ended', () => {
  let writes = 0;
  const output = {
    writableEnded: true,
    destroyed: false,
    write: () => {
      writes += 1;
      throw new Error('should not write');
    },
  };
  assert.equal(agent.appendOutput(output, 'late provider output'), false);
  assert.equal(writes, 0);
});
