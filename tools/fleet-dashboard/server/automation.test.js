'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const automation = require('./automation');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-automation-'));
  const site = path.join(root, 'sites', 'alpha.example');
  fs.mkdirSync(path.join(site, 'ops', 'social'), { recursive: true });
  fs.mkdirSync(path.join(site, 'ops', 'roles'), { recursive: true });
  fs.mkdirSync(path.join(site, 'ops', 'docker'), { recursive: true });
  fs.writeFileSync(
    path.join(site, 'ops', 'social', 'hub.yaml'),
    [
      'enabled: true',
      'platforms: [bluesky]',
      'approval: auto',
      'max_source_age_hours: 24',
      'cadence:',
      '  per_platform_per_day: 5',
      '  min_gap_minutes: 75',
      'reply:',
      '  approval: manual',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(site, 'ops', 'docker', 'crontab.docker'),
    '0 */2 * * *  bash ops/scripts/run-worker.sh news-writer\n'
  );
  fs.writeFileSync(path.join(site, 'ops', 'roles', 'news-writer.md'), '# Writer\nold prompt\n');
  return { root, site };
}

test('automation reads and updates Social Hub policy and role controls', () => {
  const { root } = fixture();
  const before = automation.get(root, 'alpha.example');
  assert.equal(before.social.config.approval, 'auto');
  assert.equal(before.roles[0].enabled, true);
  assert.equal(before.roles[0].schedule, '0 */2 * * *');

  automation.patchSocial(root, 'alpha.example', {
    approval: 'manual',
    max_source_age_hours: 6,
    cadence: { per_platform_per_day: 2, min_gap_minutes: 120 },
    platformApprovals: { bluesky: 'manual' },
  });
  automation.updateRole(root, 'alpha.example', 'news-writer', {
    enabled: false,
    schedule: '0 */4 * * *',
    prompt: '# Writer\nnew prompt\n',
  });

  const after = automation.get(root, 'alpha.example');
  assert.equal(after.social.config.approval, 'manual');
  assert.equal(after.social.config.max_source_age_hours, 6);
  assert.equal(after.social.config.cadence.min_gap_minutes, 120);
  assert.equal(after.social.config.platform_overrides.bluesky.approval, 'manual');
  assert.equal(after.roles[0].enabled, false);
  assert.equal(after.roles[0].schedule, '0 */4 * * *');
  assert.equal(after.roles[0].prompt, '# Writer\nnew prompt\n');
  assert.match(
    fs.readFileSync(path.join(root, 'sites/alpha.example/ops/docker/crontab.docker'), 'utf8'),
    /^0 \*\/4 \* \* \*\s+bash/m
  );
});

test('automation rejects invalid approval and cron schedules', () => {
  const { root } = fixture();
  assert.throws(
    () => automation.patchSocial(root, 'alpha.example', { approval: 'sometimes' }),
    /approval must be auto or manual/
  );
  assert.throws(
    () => automation.updateRole(root, 'alpha.example', 'news-writer', { schedule: 'not cron' }),
    /invalid five-field cron schedule/
  );
});

test('automation can add a new worker role with its own prompt and switch', () => {
  const { root } = fixture();
  const out = automation.createRole(root, 'alpha.example', {
    role: 'breaking-news',
    schedule: '*/30 * * * *',
    enabled: false,
    prompt: '# Breaking News\nWrite only qualifying alerts.\n',
  });
  const row = out.roles.find(r => r.role === 'breaking-news');
  assert.equal(row.enabled, false);
  assert.equal(row.schedule, '*/30 * * * *');
  assert.equal(row.prompt, '# Breaking News\nWrite only qualifying alerts.\n');
  assert.ok(fs.existsSync(path.join(root, 'sites/alpha.example/ops/.breaking-news-disabled')));
});
