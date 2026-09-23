'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBaselineTasks, readSnapshot, detail } = require('./backlinks');

test('reads a valid generated snapshot and returns site detail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-backlinks-'));
  const data = path.join(root, 'tools', 'fleet-dashboard', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, 'backlinks-latest.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-09-20T00:00:00.000Z',
      totals: { sites: 1 },
      sites: [{ site: 'example.com', status: 'missing', reports: [] }],
    })
  );
  assert.equal(readSnapshot(root).totals.sites, 1);
  assert.equal(detail(root, 'example.com').status, 'missing');
  assert.equal(detail(root, 'unknown.com'), null);
});

test('queues idempotent baseline tasks for every unmeasured site', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-backlink-tasks-'));
  const data = path.join(root, 'tools', 'fleet-dashboard', 'data');
  fs.mkdirSync(data, { recursive: true });
  const sites = ['one.example', 'two.example', 'three.example'];
  for (const site of sites)
    fs.mkdirSync(path.join(root, 'sites', site, 'ops', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(data, 'backlinks-latest.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-09-20T00:00:00.000Z',
      sites: [
        {
          site: sites[0],
          status: 'missing',
          label: 'Missing baseline',
          priority: 'high',
          recommendation: 'measure',
        },
        {
          site: sites[1],
          status: 'baseline',
          label: 'Unquantified baseline',
          priority: 'medium',
          recommendation: 'upgrade',
        },
        {
          site: sites[2],
          status: 'current',
          label: 'Current',
          priority: 'low',
          recommendation: 'monitor',
        },
      ],
    })
  );
  const first = createBaselineTasks(root);
  assert.equal(first.createdCount, 2);
  assert.equal(first.existingCount, 0);
  const second = createBaselineTasks(root);
  assert.equal(second.createdCount, 0);
  assert.equal(second.existingCount, 2);
  assert.equal(
    fs.readdirSync(path.join(root, 'sites', sites[0], 'ops', 'tasks', 'backlog')).length,
    1
  );
  const taskFile = fs.readdirSync(path.join(root, 'sites', sites[0], 'ops', 'tasks', 'backlog'))[0];
  const taskText = fs.readFileSync(
    path.join(root, 'sites', sites[0], 'ops', 'tasks', 'backlog', taskFile),
    'utf8'
  );
  assert.match(taskText, /documented no-provider path satisfies this task/);
});
