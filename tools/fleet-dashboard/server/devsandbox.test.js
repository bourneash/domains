'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('browser audit distinguishes sandbox runtime crashes from page failures', () => {
  assert.equal(
    devsandbox.isBrowserInfrastructureFailure(
      'GPU process exited unexpectedly: exit_code=9\nmojo CopyOutputResultSender'
    ),
    true
  );
  assert.equal(
    devsandbox.isBrowserInfrastructureFailure('curl: (7) Failed to connect to 127.0.0.1'),
    true
  );
  assert.equal(
    devsandbox.isBrowserInfrastructureFailure(
      'Runtime error: Browser tab has unexpectedly crashed'
    ),
    true
  );
  assert.equal(
    devsandbox.isBrowserInfrastructureFailure('Chrome prevented page load with an interstitial'),
    true
  );
});

test('published-port parsing exposes host bindings so stale allocator state is not reused', () => {
  const ports = devsandbox.parsePublishedPorts(
    '127.0.0.1:7900->4321/tcp, 0.0.0.0:8000-8001->4321/tcp'
  );
  assert.deepEqual(
    [...ports].sort((a, b) => a - b),
    [7900, 8000, 8001]
  );
});

test('improvement sandboxes mount only the site Git admin directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-devsandbox-'));
  const canonical = path.join(root, 'sites', 'example.com');
  const worktree = path.join(
    root,
    'tools/fleet-dashboard/data/improvement-worktrees/example.com--123456789abc'
  );
  const gitAdmin = path.join(root, '.git/modules/sites/example.com');
  fs.mkdirSync(canonical, { recursive: true });
  fs.mkdirSync(path.join(gitAdmin, 'worktrees', path.basename(worktree)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(canonical, '.git'), 'gitdir: ../../.git/modules/sites/example.com\n');

  const mount = devsandbox.gitWorkspaceMount(root, 'example.com', canonical, worktree);
  assert.equal(mount.hostPath, gitAdmin);
  assert.equal(mount.containerPath, '/git-store/example.com');
  assert.equal(mount.gitDir, '/git-store/example.com/worktrees/example.com--123456789abc');
  assert.equal(mount.workTree, worktree);
});
