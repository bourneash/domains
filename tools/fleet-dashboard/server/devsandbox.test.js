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

test('developer sandboxes force IPv4-first resolution for Astro Cloudflare builds', () => {
  assert.deepEqual(devsandbox.sandboxRuntimeEnvironment(), {
    NODE_OPTIONS: '--dns-result-order=ipv4first',
    UV_THREADPOOL_SIZE: '1',
    TOKIO_WORKER_THREADS: '1',
    RAYON_NUM_THREADS: '1',
    CARGO_BUILD_JOBS: '1',
    npm_config_jobs: '1',
  });
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

test('Lighthouse without a report warns instead of inventing zero scores', () => {
  const result = devsandbox.classifyLighthouseResult(
    { code: 1, stderr: 'at Connection.send (puppeteer/cdp/Connection.js:112:21)' },
    null
  );
  assert.equal(result.infrastructureWarning, true);
  assert.equal(result.lighthouse.status, 'unavailable');
  assert.deepEqual(result.lighthouse.scores, {});
  assert.ok(Object.values(result.lighthouse.checks).every(check => check.status === 'warn'));
  assert.match(result.lighthouse.checks.performance.evidence, /no score measured/);
});

test('Lighthouse with measured low scores still fails quality thresholds', () => {
  const report = {
    categories: Object.fromEntries(
      ['performance', 'accessibility', 'best-practices', 'seo'].map(key => [key, { score: 0 }])
    ),
  };
  const result = devsandbox.classifyLighthouseResult({ code: 0, stderr: '' }, report);
  assert.equal(result.infrastructureWarning, false);
  assert.equal(result.lighthouse.status, 'complete');
  assert.equal(result.lighthouse.scores.performance, 0);
  assert.equal(result.lighthouse.checks.performance.status, 'fail');
});

test('Lighthouse with incomplete categories is not considered a valid report', () => {
  const result = devsandbox.classifyLighthouseResult(
    { code: 0, stderr: '' },
    { categories: { performance: { score: 0.9 } } }
  );
  assert.equal(result.infrastructureWarning, true);
  assert.deepEqual(result.lighthouse.scores, {});
});

test('Lighthouse crash cannot turn a partial report into measured passing scores', () => {
  const report = {
    categories: Object.fromEntries(
      ['performance', 'accessibility', 'best-practices', 'seo'].map(key => [key, { score: 0.9 }])
    ),
  };
  const result = devsandbox.classifyLighthouseResult(
    { code: 1, stderr: 'Browser tab has unexpectedly crashed' },
    report
  );
  assert.equal(result.infrastructureWarning, true);
  assert.deepEqual(result.lighthouse.scores, {});
  assert.ok(Object.values(result.lighthouse.checks).every(check => check.status === 'warn'));
});

test('commands in existing developer sandboxes inherit the IPv4-first runtime', () => {
  assert.deepEqual(devsandbox.sandboxExecCommand('imp-12345678', ['dd-dev', 'status']), [
    'exec',
    '-e',
    'NODE_OPTIONS=--dns-result-order=ipv4first',
    '-e',
    'UV_THREADPOOL_SIZE=1',
    '-e',
    'TOKIO_WORKER_THREADS=1',
    '-e',
    'RAYON_NUM_THREADS=1',
    '-e',
    'CARGO_BUILD_JOBS=1',
    '-e',
    'npm_config_jobs=1',
    'dd-imp-12345678',
    'dd-dev',
    'status',
  ]);
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

test('sandbox terminal and preview ports cannot collide, including stale saved assignments', () => {
  const state = {
    ports: {
      older: { ttyd: 8100, dev: 8101 },
      current: { ttyd: 8102, dev: 8102 },
    },
  };
  const ports = devsandbox.chooseSandboxPorts(state, 'current', new Set([7900]));
  assert.equal(ports.ttyd, 8102);
  assert.notEqual(ports.dev, ports.ttyd);
  assert.notEqual(ports.dev, 7900);
  assert.notEqual(ports.dev, 8100);
  assert.notEqual(ports.dev, 8101);
  const next = devsandbox.chooseSandboxPorts({ ports: { ...state.ports, current: ports } }, 'next');
  assert.notEqual(next.ttyd, next.dev);
  assert.ok(!Object.values(ports).includes(next.ttyd));
  assert.ok(!Object.values(ports).includes(next.dev));
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
