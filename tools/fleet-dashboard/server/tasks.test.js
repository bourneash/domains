'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tasks = require('./tasks');

test('cross-fleet task listing reuses parsed cards and notices file changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tasks-cache-'));
  const backlog = path.join(root, 'sites', 'example.test', 'ops', 'tasks', 'backlog');
  fs.mkdirSync(backlog, { recursive: true });
  const taskFile = path.join(backlog, 'first.md');
  fs.writeFileSync(taskFile, '---\ntitle: First task\npriority: 2\n---\n\nInitial body.\n');

  const originalRead = fs.readFileSync;
  let taskReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).startsWith(path.join(root, 'sites') + path.sep)) taskReads++;
    return originalRead.call(this, file, ...args);
  };
  try {
    const first = tasks.listAll(root, ['example.test']);
    assert.equal(first.length, 1);
    assert.equal(first[0].title, 'First task');
    assert.equal(taskReads, 1);

    const cached = tasks.listAll(root, ['example.test']);
    assert.equal(cached[0], first[0]);
    assert.equal(taskReads, 1);

    fs.writeFileSync(
      taskFile,
      '---\ntitle: Updated task with changed size\npriority: 1\n---\n\nUpdated body.\n'
    );
    const updated = tasks.listAll(root, ['example.test']);
    assert.equal(updated[0].title, 'Updated task with changed size');
    assert.equal(updated[0].priority, 1);
    assert.equal(taskReads, 2);

    fs.writeFileSync(path.join(backlog, 'second.md'), '---\ntitle: Second task\n---\n\nBody.\n');
    assert.deepEqual(
      tasks.listAll(root, ['example.test']).map(row => row.title),
      ['Updated task with changed size', 'Second task']
    );
    fs.unlinkSync(taskFile);
    assert.deepEqual(
      tasks.listAll(root, ['example.test']).map(row => row.title),
      ['Second task']
    );
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fleet task response contains only the fields used by its table and filters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-task-summary-'));
  const backlog = path.join(root, 'sites', 'example.test', 'ops', 'tasks', 'backlog');
  fs.mkdirSync(backlog, { recursive: true });
  fs.writeFileSync(
    path.join(backlog, 'first.md'),
    '---\ntitle: First task\npriority: 2\ntype: performance\nassigned_role: engineer\ncreated: 2026-10-01\nestimated_turns: 3\n---\n\nTask body.\n'
  );
  try {
    const [task] = tasks.listFleet(root, ['example.test']);
    assert.deepEqual(Object.keys(task), [
      'site',
      'file',
      'column',
      'title',
      'priority',
      'type',
      'assigned_role',
      'created',
      'estimated_turns',
      'blocked_on',
    ]);
    assert.equal(task.title, 'First task');
    assert.equal(task.blocked_on, '');
    assert.ok(!('excerpt' in task));
    assert.ok(!('source_id' in task));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
