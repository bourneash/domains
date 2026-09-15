'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tasks = require('./tasks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('task serialization preserves lineage and measurement fields', () => {
  const text = tasks.serializeTask({
    task_id: 'task-1', title: 'Measure this', source: 'seo-intelligence', source_id: 'finding-1',
    correlation_id: 'seo:finding-1', measurement_due: '2026-10-13', assigned_role: 'seo-analyst',
  }, 'Baseline');
  const parsed = tasks.parseTask(text);
  assert.equal(parsed.meta.task_id, 'task-1');
  assert.equal(parsed.meta.correlation_id, 'seo:finding-1');
  assert.equal(parsed.meta.measurement_due, '2026-10-13');
});

test('moving a task records lifecycle timestamps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lineage-'));
  const dir = path.join(root, 'sites', 'a.com', 'ops', 'tasks', 'backlog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), tasks.serializeTask({ title: 'A' }, 'Body'));
  let moved = tasks.move(root, 'a.com', 'backlog', 'a.md', 'in-progress');
  assert.ok(tasks.get(root, 'a.com', moved.column, moved.file).meta.started_at);
  moved = tasks.move(root, 'a.com', 'in-progress', moved.file, 'done');
  assert.ok(tasks.get(root, 'a.com', moved.column, moved.file).meta.completed_at);
});
