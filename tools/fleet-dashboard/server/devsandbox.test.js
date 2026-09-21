'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const devsandbox = require('./devsandbox');

test('developer sandboxes use a deterministic private network name', () => {
  assert.match(devsandbox.sandboxNetworkName('imp-example'), /^dd-net-[a-f0-9]{16}$/);
  assert.equal(
    devsandbox.sandboxNetworkName('imp-example'),
    devsandbox.sandboxNetworkName('imp-example')
  );
  assert.notEqual(devsandbox.sandboxNetworkName('imp-a'), devsandbox.sandboxNetworkName('imp-b'));
});

test('developer sandboxes drop capabilities and keep writable state explicit', () => {
  const args = devsandbox.sandboxSecurityArgs();
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges:true'));
  assert.ok(args.includes('/tmp:rw,noexec,nosuid,size=1g'));
  assert.ok(args.includes('/home/dev/.codex') === false);
});
