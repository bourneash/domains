'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pr = require('./github-pr');

test('creates a real pull request for a pushed improvement branch', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () =>
        calls.length === 1
          ? []
          : {
              number: 42,
              html_url: 'https://github.com/acme/site/pull/42',
              state: 'open',
              head: { sha: 'abc' },
            },
    };
  };
  const result = await pr.ensure(
    '/tmp',
    'https://github.com/acme/site',
    'improvement/abcd',
    'A fix',
    'Details',
    {
      fetchImpl,
      env: { GITHUB_TOKEN: 'test-token' },
    }
  );
  assert.equal(result.number, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(JSON.parse(calls[1].options.body).base, 'main');
});

test('reuses an existing pull request and rejects non-GitHub targets', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      { number: 7, html_url: 'https://github.com/acme/site/pull/7', state: 'open' },
    ],
  });
  const result = await pr.ensure(
    '/tmp',
    'https://github.com/acme/site',
    'improvement/abcd',
    'A fix',
    'Details',
    {
      fetchImpl,
      env: { GITHUB_TOKEN: 'test-token' },
    }
  );
  assert.equal(result.number, 7);
  await assert.rejects(
    () => pr.ensure('/tmp', 'https://other.test/acme/site', 'improvement/abcd', 'A', 'B'),
    /GitHub repository/
  );
});
