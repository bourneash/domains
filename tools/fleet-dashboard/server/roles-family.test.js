'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const roles = require('./roles');
const routing = require('./task-routing');

const ROOT = path.resolve(__dirname, '../../..');

test('editorial family exposes exact profiles and preserves site-level health rows', async () => {
  const slugs = ['amputeenews.com', '0daynews.com', 'americastrikes.com'];
  const family = roles.agents(ROOT, slugs).find(agent => agent.role === 'update');
  assert.deepEqual(family.profiles, ['update', 'content-writer', 'news-writer']);
  assert.equal(family.sites, 3);

  const health = await roles.health(ROOT, 'update', slugs, { by_site_role: [] });
  assert.equal(health.family.role, 'update');
  assert.deepEqual(health.rows.map(row => `${row.site}:${row.role}`).sort(), [
    '0daynews.com:news-writer',
    'americastrikes.com:update',
    'amputeenews.com:content-writer',
  ]);
  assert.ok(health.rows.every(row => row.editorial && row.editorial.deploy));
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
  assert.match(source, /data-role="\$\{esc\(actualRole\)\}"/);
  assert.match(source, /if \(!familyPage\)/);
});
