'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { _sanitizeBody, _actorFingerprint } = require('./actionlog');

test('sanitizeBody redacts secret-bearing fields', () => {
  const out = _sanitizeBody({ enabled: true, token: 'hunter2', password: 'p', nested: { secret: 's' } });
  assert.match(out, /"enabled":true/);
  assert.match(out, /"token":"\[redacted\]"/);
  assert.match(out, /"password":"\[redacted\]"/);
  assert.match(out, /"secret":"\[redacted\]"/);
  assert.doesNotMatch(out, /hunter2/);
});

test('sanitizeBody returns undefined for empty/non-object bodies', () => {
  assert.strictEqual(_sanitizeBody({}), undefined);
  assert.strictEqual(_sanitizeBody(null), undefined);
  assert.strictEqual(_sanitizeBody('str'), undefined);
});

test('actorFingerprint hashes the token, never storing it verbatim', () => {
  const fp = _actorFingerprint({ headers: { 'x-fd-token': 'super-secret' } });
  assert.match(fp, /^tok:[0-9a-f]{8}$/);
  assert.doesNotMatch(fp, /super-secret/);
});

test('actorFingerprint reads the fd_auth cookie and is stable', () => {
  const req = { headers: { cookie: 'a=1; fd_auth=abc123; b=2' } };
  const fp1 = _actorFingerprint(req);
  const fp2 = _actorFingerprint(req);
  assert.match(fp1, /^tok:[0-9a-f]{8}$/);
  assert.strictEqual(fp1, fp2);
});

test('actorFingerprint is "anon" without any credential', () => {
  assert.strictEqual(_actorFingerprint({ headers: {} }), 'anon');
});
