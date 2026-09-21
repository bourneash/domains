'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('./improvement-agent');

test('provider executable defaults match the configured queue providers', () => {
  assert.equal(agent.providerExecutable('claude'), 'claude');
  assert.equal(agent.providerExecutable('chatgpt'), 'codex');
  assert.equal(agent.providerExecutable('local'), 'ollama');
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
