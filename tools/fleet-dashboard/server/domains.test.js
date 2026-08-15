'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const domains = require('./domains');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-domains-'));
  fs.mkdirSync(path.join(root, 'sites'), { recursive: true });
  return root;
}

test('rejects anything that is not a bare hostname', () => {
  const root = tmpRoot();
  for (const bad of [
    '',
    'example',
    'https://example.com',
    'example.com/path',
    'exam ple.com',
    'example..com',
    '-example.com',
    'example.com;rm -rf /',
    'a'.repeat(260) + '.com',
  ]) {
    assert.throws(
      () => domains.validate(root, { command: 'status', domain: bad, flags: [] }),
      /domain/
    );
  }
});

test('normalizes the host and accepts a valid domain', () => {
  const root = tmpRoot();
  const r = domains.validate(root, { command: 'status', domain: '  Example.COM ', flags: [] });
  assert.strictEqual(r.domain, 'example.com');
});

test('rejects unknown commands and out-of-allowlist flags', () => {
  const root = tmpRoot();
  assert.throws(
    () => domains.validate(root, { command: 'rm', domain: 'example.com', flags: [] }),
    /unsupported command/
  );
  assert.throws(
    () =>
      domains.validate(root, { command: 'add', domain: 'example.com', flags: ['--delete-repo'] }),
    /unsupported flag/
  );
  // A remove-only flag must not be smuggled through add, and vice-versa.
  assert.throws(
    () => domains.validate(root, { command: 'remove', domain: 'example.com', flags: ['--full'] }),
    /unsupported flag/
  );
  // Fleet policy: repos are archived, never deleted. remove-domain.sh accepts
  // --delete-repo but the dashboard must never be able to reach it.
  assert.throws(
    () =>
      domains.validate(root, {
        command: 'remove',
        domain: 'example.com',
        flags: ['--delete-repo'],
      }),
    /unsupported flag/
  );
});

test('onboard refuses a domain that is already checked out; repair refuses one that is not', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'sites', 'taken.com'));
  assert.throws(
    () => domains.validate(root, { command: 'add', domain: 'taken.com', flags: [] }),
    /already exists/
  );
  assert.throws(
    () => domains.validate(root, { command: 'repair', domain: 'absent.com', flags: [] }),
    /does not exist/
  );
  // Offboarding an existing checkout is exactly what remove is for.
  assert.doesNotThrow(() =>
    domains.validate(root, { command: 'remove', domain: 'taken.com', flags: [] })
  );
});

test('enqueue writes a queued job the runner can find, and refuses a second one for the same domain', () => {
  const root = tmpRoot();
  const job = domains.enqueue(root, { command: 'add', domain: 'new.com', flags: ['--full'] });

  assert.strictEqual(job.status, 'queued');
  assert.strictEqual(job.domain, 'new.com');
  assert.deepStrictEqual(job.flags, ['--full']);
  assert.ok(domains.isJobId(job.id), `id ${job.id} is not runner-readable`);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(domains.spoolDir(root), `${job.id}.json`), 'utf8')
  );
  assert.strictEqual(onDisk.id, job.id);

  assert.throws(
    () => domains.enqueue(root, { command: 'status', domain: 'new.com', flags: [] }),
    /already queued/
  );
  // A different domain is unaffected by that lock.
  assert.doesNotThrow(() =>
    domains.enqueue(root, { command: 'add', domain: 'other.com', flags: [] })
  );
});

test('listJobs is newest-first and ignores junk in the spool', () => {
  const root = tmpRoot();
  const a = domains.enqueue(root, { command: 'add', domain: 'a.com', flags: [] });
  const b = domains.enqueue(root, { command: 'add', domain: 'b.com', flags: [] });
  fs.writeFileSync(path.join(domains.spoolDir(root), 'not-a-job.json'), 'garbage');
  fs.writeFileSync(path.join(domains.spoolDir(root), '.heartbeat'), '');

  const ids = domains.listJobs(root).map(j => j.id);
  assert.deepStrictEqual(ids, [b.id, a.id].sort().reverse());
  assert.strictEqual(ids.length, 2);
});

test('cancel only applies to queued jobs', () => {
  const root = tmpRoot();
  const job = domains.enqueue(root, { command: 'add', domain: 'c.com', flags: [] });
  const cancelled = domains.cancel(root, job.id);
  assert.strictEqual(cancelled.status, 'cancelled');
  // Once it is no longer queued, cancelling again must fail rather than
  // pretend it stopped something.
  assert.throws(() => domains.cancel(root, job.id), /only queued/);
  assert.throws(() => domains.cancel(root, 'nope'), /invalid job id/);
});

test('runner health reports not-alive when nothing has ticked', () => {
  const root = tmpRoot();
  const r = domains.runner(root);
  assert.strictEqual(r.alive, false);
  assert.strictEqual(r.lastTick, null);
  assert.strictEqual(r.installed, false);
});

test('jobLog tolerates a job the runner has not started yet', () => {
  const root = tmpRoot();
  const job = domains.enqueue(root, { command: 'add', domain: 'd.com', flags: [] });
  const r = domains.jobLog(root, job.id);
  assert.strictEqual(r.log, '');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.job.id, job.id);
  assert.throws(() => domains.jobLog(root, '20260101-000000-aaaaaa'), /unknown job/);
});
