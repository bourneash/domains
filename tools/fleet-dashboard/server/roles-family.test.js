'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const roles = require('./roles');
const routing = require('./task-routing');

const ROOT = path.resolve(__dirname, '../../..');

test('editorial family exposes exact profiles and preserves site-level health rows', async () => {
  const slugs = ['amputeenews.com', '0daynews.com', 'americastrikes.com'];
  const family = roles.agents(ROOT, slugs).find(agent => agent.role === 'update');
  assert.deepEqual(family.profiles, [
    'update',
    'content-writer',
    'news-writer',
    'news-writer-local',
    'breaking-news',
    'weekly-editorial',
  ]);
  assert.equal(family.sites, 3);

  const health = await roles.health(ROOT, 'update', slugs, { by_site_role: [] });
  assert.equal(health.family.role, 'update');
  assert.deepEqual(health.rows.map(row => `${row.site}:${row.role}`).sort(), [
    '0daynews.com:news-writer',
    'americastrikes.com:breaking-news',
    'americastrikes.com:news-writer-local',
    'americastrikes.com:update',
    'americastrikes.com:weekly-editorial',
    'amputeenews.com:content-writer',
  ]);
  assert.ok(health.rows.every(row => row.editorial && row.editorial.deploy));
  assert.ok(Array.isArray(health.alerts));
});

test('role matrix shares scans for thirty seconds and still honors explicit invalidation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-matrix-cache-'));
  const ops = path.join(root, 'sites', 'example.test', 'ops');
  const logs = path.join(ops, 'logs');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    '*/10 * * * * bash ops/scripts/run-worker.sh planner\n'
  );
  const originalNow = Date.now;
  const originalReaddir = fs.readdirSync;
  let now = 1_000_000;
  let logDirectoryReads = 0;
  Date.now = () => now;
  fs.readdirSync = function (directory, ...args) {
    if (String(directory) === logs) logDirectoryReads++;
    return originalReaddir.call(this, directory, ...args);
  };
  try {
    const first = await roles.matrix(root, ['example.test']);
    now += 3000;
    const cached = await roles.matrix(root, ['example.test']);
    assert.equal(cached, first);
    assert.equal(logDirectoryReads, 1);

    roles.invalidateMatrix(root);
    now += 1000;
    const invalidated = await roles.matrix(root, ['example.test']);
    assert.notEqual(invalidated, first);
    assert.equal(logDirectoryReads, 2);

    now += 20000;
    const stillCached = await roles.matrix(root, ['example.test']);
    assert.equal(stillCached, invalidated);
    assert.equal(logDirectoryReads, 2);

    now += 10001;
    const expired = await roles.matrix(root, ['example.test']);
    assert.notEqual(expired, invalidated);
    assert.equal(logDirectoryReads, 3);
  } finally {
    Date.now = originalNow;
    fs.readdirSync = originalReaddir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent enrollment returns the same worker and enabled controls without building the full matrix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-agent-enrollment-'));
  const ops = path.join(root, 'sites', 'example.test', 'ops');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    '*/10 * * * * bash ops/scripts/run-worker.sh engineer\n'
  );
  fs.writeFileSync(path.join(ops, '.engineer-disabled'), '');
  try {
    const enrollment = roles.enrollment(root, ['example.test', 'empty.test'], 'engineer');
    assert.deepEqual(enrollment.allSites, ['example.test', 'empty.test']);
    assert.deepEqual(enrollment.sites, [
      {
        site: 'example.test',
        cells: { engineer: { scheduled: true, enabled: false, worker: true } },
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact Agent health keeps counts and recent detail while preserving the full result', () => {
  const slots = Array.from({ length: 100 }, (_, index) => ({ at: index, status: 'ok' }));
  const full = {
    summary: { expected: 100, missed: 4 },
    rows: [
      {
        site: 'example.test',
        execution: { expected: 100, slots, extras: [{ at: 101, status: 'unknown' }] },
      },
    ],
  };
  const compact = roles.compactHealth(full);
  assert.deepEqual(compact.summary, full.summary);
  assert.deepEqual(compact.rows[0].execution, { slots: slots.slice(-12) });
  assert.equal(full.rows[0].execution.slots.length, 100);
});

test('role matrix reads only newest run, publication, and deploy logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-matrix-perf-'));
  const site = path.join(root, 'sites', 'example.test');
  const ops = path.join(site, 'ops');
  const logs = path.join(ops, 'logs');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    '0 7 * * * bash ops/scripts/run-worker.sh update\n'
  );
  const fixtures = [
    ['update-20261001.log', 'Published /articles/older-story', 2],
    ['update-20261002.log', 'NO-OP: nothing published', 1],
    ['deployer-20261001.log', 'deploy FAIL exit=1', 4],
    ['deployer-20261002.log', 'deploy SUCCESS', 3],
  ];
  for (const [name, text, daysAgo] of fixtures) {
    const file = path.join(logs, name);
    fs.writeFileSync(file, text);
    const stamp = new Date(Date.now() - daysAgo * 86400000);
    fs.utimesSync(file, stamp, stamp);
  }

  const originalRead = fs.readFileSync;
  const originalStat = fs.statSync;
  const originalReaddir = fs.readdirSync;
  const logReads = [];
  const logStats = [];
  let crontabReads = 0;
  let logDirectoryReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).startsWith(logs + path.sep)) logReads.push(path.basename(String(file)));
    if (String(file).endsWith(path.join('ops', 'docker', 'crontab'))) crontabReads++;
    return originalRead.call(this, file, ...args);
  };
  fs.statSync = function (file, ...args) {
    if (String(file).startsWith(logs + path.sep)) logStats.push(path.basename(String(file)));
    return originalStat.call(this, file, ...args);
  };
  fs.readdirSync = function (directory, ...args) {
    if (String(directory) === logs) logDirectoryReads++;
    return originalReaddir.call(this, directory, ...args);
  };
  try {
    const matrix = await roles.matrix(root, ['example.test']);
    const editorial = matrix.sites[0].cells.update.editorial;
    assert.equal(editorial.attemptedFile, 'update-20261002.log');
    assert.equal(editorial.noOp, true);
    assert.equal(editorial.publication.slug, 'older-story');
    assert.equal(editorial.deploy.state, 'success');
    assert.deepEqual(logReads.sort(), [
      'deployer-20261002.log',
      'update-20261001.log',
      'update-20261002.log',
    ]);
    assert.equal(logDirectoryReads, 1);
    assert.equal(crontabReads, 1);
    assert.deepEqual(logStats.sort(), fixtures.map(([name]) => name).sort());
  } finally {
    fs.readFileSync = originalRead;
    fs.statSync = originalStat;
    fs.readdirSync = originalReaddir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent health shares each role log read across stats, history, and telemetry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-health-perf-'));
  const logs = path.join(root, 'sites', 'example.test', 'ops', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const ranAt = new Date();
  const logName = `update-${ranAt.toISOString().slice(0, 10).replaceAll('-', '')}.log`;
  fs.writeFileSync(
    path.join(logs, logName),
    `started at ${ranAt.toISOString()}\nfinished at ${ranAt.toISOString()} (exit=0)\nPublished /articles/current-story\n`
  );
  fs.writeFileSync(
    path.join(logs, `update-local-${ranAt.toISOString().slice(0, 10).replaceAll('-', '')}.log`),
    'a different role family profile, not an update run'
  );
  const originalRead = fs.readFileSync;
  const logReads = [];
  let crontabReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).startsWith(logs + path.sep)) logReads.push(path.basename(String(file)));
    if (String(file).includes(path.join('ops', 'docker', 'crontab'))) crontabReads++;
    return originalRead.call(this, file, ...args);
  };
  try {
    const result = await roles.health(
      root,
      'update',
      ['example.test'],
      {},
      false,
      {
        sites: [
          {
            site: 'example.test',
            cells: { update: { schedule: '0 7 * * *', enabled: false, state: 'paused' } },
          },
        ],
      }
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].observed, 1);
    assert.equal(result.rows[0].succeeded, 1);
    assert.equal(result.rows[0].editorial.publication.slug, 'current-story');
    assert.deepEqual(logReads, [logName]);
    assert.equal(crontabReads, 0);
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent health reuses unchanged log contents across reports and reloads edited logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-health-content-cache-'));
  const logs = path.join(root, 'sites', 'example.test', 'ops', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const ranAt = new Date();
  const logName = `update-${ranAt.toISOString().slice(0, 10).replaceAll('-', '')}-0700.log`;
  const logPath = path.join(logs, logName);
  fs.writeFileSync(
    logPath,
    `started at ${ranAt.toISOString()}\nfinished at ${ranAt.toISOString()} (exit=0)\n`
  );
  const matrix = {
    sites: [
      {
        site: 'example.test',
        cells: { update: { schedule: '0 7 * * *', enabled: true, state: 'fresh', worker: true } },
      },
    ],
  };
  const originalRead = fs.readFileSync;
  let logReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file) === logPath) logReads++;
    return originalRead.call(this, file, ...args);
  };
  try {
    const first = await roles.health(root, 'update', ['example.test'], {}, false, matrix);
    const second = await roles.health(root, 'update', ['example.test'], {}, false, matrix);
    assert.equal(first.rows[0].observed, second.rows[0].observed);
    assert.equal(logReads, 1);

    const changedLog = originalRead.call(fs, logPath, 'utf8').replace('(exit=0)', '(exit=1)');
    fs.writeFileSync(logPath, changedLog);
    const changedTime = new Date(Date.now() + 2000);
    fs.utimesSync(logPath, changedTime, changedTime);
    const edited = await roles.health(root, 'update', ['example.test'], {}, false, matrix);
    assert.equal(edited.rows[0].observed, 1);
    assert.equal(edited.rows[0].failed, 1);
    assert.equal(logReads, 2);
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent health skips dated run logs outside the history scan window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-health-window-'));
  const logs = path.join(root, 'sites', 'example.test', 'ops', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const today = new Date();
  const todayName = `planner-${today.toISOString().slice(0, 10).replaceAll('-', '')}.log`;
  const oldName = 'planner-20260101.log';
  fs.writeFileSync(
    path.join(logs, todayName),
    `started at ${today.toISOString()}\nfinished at ${today.toISOString()} (exit=0)\n`
  );
  fs.writeFileSync(path.join(logs, oldName), 'historical run');
  const oldTime = new Date('2026-01-01T12:00:00Z');
  fs.utimesSync(path.join(logs, oldName), oldTime, oldTime);
  const originalRead = fs.readFileSync;
  const originalStat = fs.statSync;
  const logReads = [];
  const logStats = [];
  fs.readFileSync = function (file, ...args) {
    if (String(file).startsWith(logs + path.sep)) logReads.push(path.basename(String(file)));
    return originalRead.call(this, file, ...args);
  };
  fs.statSync = function (file, ...args) {
    if (String(file).startsWith(logs + path.sep)) logStats.push(path.basename(String(file)));
    return originalStat.call(this, file, ...args);
  };
  try {
    const result = await roles.health(
      root,
      'planner',
      ['example.test'],
      {},
      false,
      {
        sites: [
          {
            site: 'example.test',
            cells: { planner: { schedule: '0 * * * *', enabled: true, state: 'fresh' } },
          },
        ],
      }
    );
    assert.equal(result.rows[0].observed, 1);
    assert.deepEqual(logReads, [todayName]);
    assert.deepEqual(logStats, [todayName]);
  } finally {
    fs.readFileSync = originalRead;
    fs.statSync = originalStat;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task routing uses the shared editorial family candidates', () => {
  assert.equal(routing.assignedRoleForType('content', 'engineer'), 'content-writer');
  assert.equal(
    routing.assignedRoleForSite('content', 'content-writer', ['news-writer']),
    'news-writer'
  );
});

test('generic agent UI exposes cadence, publishing telemetry, and exact-role controls', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  assert.match(source, /editorialCadenceLabel/);
  assert.match(source, /editorialTelemetryCell/);
  assert.match(source, /publishing alert/);
  assert.match(source, /data-role="\$\{esc\(actualRole\)\}"/);
  assert.match(source, /if \(!familyPage\)/);
});
