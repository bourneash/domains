'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./workflow-engine');

const item = (id, status = 'open', priority = 'normal') => ({
  source: 'work-item',
  id,
  title: id,
  status,
  priority,
});
test('computes blockers, readiness, and critical downstream work', () => {
  const result = engine.evaluate({
    items: [item('a', 'done'), item('b'), item('c', 'open', 'high')],
    links: [
      {
        from_type: 'work-item',
        from_id: 'a',
        to_type: 'work-item',
        to_id: 'b',
        relation: 'blocks',
      },
      {
        from_type: 'work-item',
        from_id: 'b',
        to_type: 'work-item',
        to_id: 'c',
        relation: 'blocks',
      },
    ],
  });
  assert.equal(result.nodes['work-item:b'].ready, true);
  assert.deepEqual(result.nodes['work-item:c'].blockers, ['work-item:b']);
  assert.ok(result.critical_path.includes('work-item:a'));
});
test('detects circular dependencies and overdue work', () => {
  const result = engine.evaluate({
    items: [item('a'), { ...item('b'), due_at: '2020-01-01T00:00:00Z' }],
    links: [
      {
        from_type: 'work-item',
        from_id: 'a',
        to_type: 'work-item',
        to_id: 'b',
        relation: 'blocks',
      },
      {
        from_type: 'work-item',
        from_id: 'b',
        to_type: 'work-item',
        to_id: 'a',
        relation: 'blocks',
      },
    ],
  });
  assert.equal(result.cycles.length, 1);
  assert.ok(result.alerts.some(alert => alert.kind === 'overdue'));
});
test('returns effort-weighted graph edges and stable alert keys', () => {
  const result = engine.evaluate({
    items: [
      { ...item('a'), estimate_minutes: 240 },
      { ...item('b', 'open', 'high'), estimate_minutes: 10, due_at: '2020-01-01T00:00:00Z' },
    ],
    links: [
      {
        from_type: 'work-item',
        from_id: 'a',
        to_type: 'work-item',
        to_id: 'b',
        relation: 'blocks',
      },
    ],
  });
  assert.deepEqual(result.edges, [{ from: 'work-item:a', to: 'work-item:b', relation: 'blocks' }]);
  assert.equal(result.nodes['work-item:a'].effort_minutes, 240);
  assert.ok(result.alerts.every(alert => alert.dedupe_key));
});
