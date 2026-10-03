'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const intel = require('./executive-intel');

test('catalog covers the dashboard intelligence needed by executive roles', () => {
  const keys = new Set(intel.TOOL_CATALOG.map(item => item.key));
  for (const key of [
    'registry',
    'analytics',
    'seo_intelligence',
    'revenue',
    'ai_usage',
    'social',
    'datahub',
    'priorities',
    'operations',
    'compliance',
    'data_quality',
    'security',
  ]) {
    assert.ok(keys.has(key), `missing ${key}`);
  }
});

test('removes excluded-site data at every nesting level', () => {
  const result = intel.removeExcluded({
    sites: [{ site: 'good.example' }, { site: '3boobs.com' }],
    keyed: { 'good.example': { value: 1 }, '3boobs.com': { value: 2 } },
    nested: { domain: '3boobs.com', secret: true },
  });
  assert.deepEqual(result, {
    sites: [{ site: 'good.example' }],
    keyed: { 'good.example': { value: 1 } },
  });
});

test('source wrapper preserves explicit failures instead of presenting zeros', () => {
  const result = intel.source('analytics', { ok: false, error: 'hub unavailable' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'hub unavailable');
  assert.deepEqual(result.data, { ok: false, error: 'hub unavailable' });
});

test('compact priorities preserves only verified executable task-routing repairs', () => {
  const result = intel.compactPriorities({
    items: [
      {
        id: 'task-routing:one',
        site: 'one.example',
        source: 'task-routing-audit',
        state: 'blocked',
        score: 96,
        task: {
          file: 'task.md',
          column: 'backlog',
          task_type: 'engineering',
          expected_role: 'engineer',
        },
      },
      {
        id: 'task-routing:two',
        site: 'one.example',
        source: 'task-routing-audit',
        state: 'blocked',
        score: 91,
        task: {
          file: 'older.md',
          column: 'backlog',
          task_type: 'engineering',
          expected_role: 'engineer',
        },
      },
      {
        id: 'task-owner:three',
        site: 'two.example',
        source: 'task-board',
        state: 'blocked',
        task: { file: 'task.md', column: 'backlog' },
      },
      {
        id: 'task-routing:four',
        site: 'four.example',
        source: 'task-routing-audit',
        state: 'blocked',
        task: {
          file: 'task.md',
          column: 'backlog',
          task_type: 'refresh',
          expected_role: 'engineer',
        },
      },
    ],
  });
  assert.deepEqual(
    result.routable_task_repairs.map(item => item.id),
    ['task-routing:one']
  );
  assert.equal(result.routable_task_repairs[0].task.type, 'engineering');
});

test('compact priorities resolves a legacy routing item type from its canonical task card', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-intel-routing-'));
  const taskPath = path.join(
    root,
    'sites',
    'writer.example',
    'ops',
    'tasks',
    'backlog',
    'guide.md'
  );
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(
    taskPath,
    '---\nsite: writer.example\ntype: content\nassigned_role: missing-writer\n---\nWrite this guide.\n'
  );
  try {
    const result = intel.compactPriorities(
      {
        items: [
          {
            id: 'task-routing:writer.example:guide.md',
            site: 'writer.example',
            source: 'task-routing-audit',
            state: 'blocked',
            task: { file: 'guide.md', column: 'backlog', expected_role: 'content-writer' },
          },
        ],
      },
      root
    );
    assert.equal(result.routable_task_repairs[0].task.type, 'content');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
