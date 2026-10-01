'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const view = require('./changequeue-view');

test('explains queue blockers using the same site locks as dispatch', () => {
  const request = { status: 'queued', site: 'example.com', delivery_mode: 'direct' };
  const blockers = view.queueBlockers(request, {
    activeCount: 2,
    capacity: 2,
    busySites: new Set(['example.com']),
    measuringSites: new Set(['example.com']),
  });
  assert.deepEqual(
    blockers.map(item => item.code),
    ['capacity', 'site_active', 'measurement_window']
  );
  assert.match(blockers[1].detail, /build or review/);
});

test('report-only work can proceed during a measurement window', () => {
  const blockers = view.queueBlockers(
    { status: 'queued', site: 'example.com', delivery_mode: 'report_only' },
    { activeCount: 0, capacity: 2, measuringSites: new Set(['example.com']) }
  );
  assert.deepEqual(blockers, []);
});

test('diagnostic and control-plane work can proceed during a site measurement', () => {
  for (const request of [
    {
      status: 'queued',
      site: 'example.com',
      delivery_mode: 'direct',
      category: 'engineering',
      title: 'Measurement coverage review',
    },
    {
      status: 'queued',
      site: 'example.com',
      delivery_mode: 'direct',
      category: 'engineering',
      title: 'Reassign task to engineer: Route performance-budget task',
      action_key: 'task-routing:example:task.md',
    },
  ]) {
    assert.deepEqual(
      view.queueBlockers(request, {
        measuringRuns: [
          {
            site: 'example.com',
            state: 'measuring',
            title: 'Improve /homepage',
            baseline: { evidence: 'homepage' },
          },
        ],
      }),
      []
    );
  }
});

test('explicit measurement and readiness follow-through can proceed during a site measurement', () => {
  for (const title of [
    'Follow through: Measure the deployed homepage refresh',
    'Follow through: Run bounded revenue-readiness baseline',
  ]) {
    assert.deepEqual(
      view.queueBlockers(
        {
          status: 'queued',
          site: 'example.com',
          delivery_mode: 'direct',
          category: 'engineering',
          title,
        },
        {
          measuringRuns: [
            {
              site: 'example.com',
              state: 'measuring',
              title: 'Ship homepage refresh',
              baseline: { request_category: 'engineering' },
            },
          ],
        }
      ),
      []
    );
  }
});

test('only overlapping production scope is held', () => {
  const run = {
    site: 'example.com',
    state: 'measuring',
    title: 'Improve /homepage',
    baseline: { evidence: 'homepage' },
  };
  assert.equal(
    view.measurementConflict(
      { site: 'example.com', title: 'Improve /homepage CTA', body: 'Change /homepage' },
      run
    ),
    true
  );
  assert.equal(
    view.measurementConflict(
      { site: 'example.com', title: 'Improve /about', body: 'Change /about' },
      run
    ),
    false
  );
});

test('independent explicit delivery categories can proceed during measurement', () => {
  const run = {
    site: 'example.com',
    state: 'measuring',
    title: 'Ship homepage design refresh',
    baseline: { request_category: 'engineering' },
  };
  assert.equal(
    view.measurementConflict(
      { site: 'example.com', category: 'seo', title: 'Repair affiliate search path' },
      run
    ),
    false
  );
  assert.equal(
    view.measurementConflict(
      { site: 'example.com', category: 'engineering', title: 'Tune homepage layout' },
      run
    ),
    true
  );
});

test('independent lanes are not held by a stale measurement retry date', () => {
  const request = {
    site: 'example.com',
    category: 'design',
    delivery_mode: 'direct',
    title: 'Ship a bounded design improvement',
    next_attempt_at: '2026-10-12T00:00:00.000Z',
  };
  const run = {
    site: 'example.com',
    state: 'measuring',
    baseline: { request_category: 'seo' },
  };
  assert.equal(view.measurementConflict(request, run), false);
});

test('report-only work can proceed while an implementation is active', () => {
  const blockers = view.queueBlockers(
    { status: 'queued', site: 'example.com', delivery_mode: 'report_only' },
    { activeCount: 1, capacity: 2, busySites: new Set(['example.com']) }
  );
  assert.deepEqual(blockers, []);
});

test('parked infrastructure reviews do not reserve a site for dispatch or the queue view', () => {
  const requests = [
    { request_id: 'old', status: 'blocked_infrastructure', site: 'example.com' },
    { request_id: 'next', status: 'queued', site: 'example.com', delivery_mode: 'direct' },
  ];
  const runs = [{ site: 'example.com', state: 'review', source_id: 'old' }];
  assert.equal(view.busyImplementationSites(runs, requests).has('example.com'), false);
  const rows = view.enrichChangeRequests(
    fs.mkdtempSync(path.join(os.tmpdir(), 'changequeue-parked-')),
    requests,
    { max_concurrent: 2 },
    runs
  );
  assert.equal(rows[1].queue_block.blocked, false);
  assert.equal(
    view.busyImplementationSites([{ ...runs[0], state: 'building' }], requests).has('example.com'),
    true
  );
  assert.equal(
    view
      .busyImplementationSites(runs, [{ ...requests[0], status: 'reviewing' }])
      .has('example.com'),
    true
  );
});

test('exposes measurement deadline and honors a per-request override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changequeue-measurement-'));
  const rows = view.enrichChangeRequests(
    root,
    [
      {
        request_id: 'measurement-1',
        status: 'queued',
        site: 'example.com',
        delivery_mode: 'direct',
        created_at: '2026-09-26T10:00:00.000Z',
      },
    ],
    { max_concurrent: 4 },
    [{ site: 'example.com', state: 'measuring', measurement_due: '2026-10-10' }]
  );
  assert.equal(rows[0].measurement_window.due_at, '2026-10-10');
  assert.equal(rows[0].queue_block.primary.code, 'measurement_window');
  const overridden = view.enrichChangeRequests(
    root,
    [{ ...rows[0], measurement_override: 1 }],
    { max_concurrent: 4 },
    [{ site: 'example.com', state: 'measuring', measurement_due: '2026-10-10' }]
  );
  assert.equal(overridden[0].queue_block.blocked, false);
  assert.equal(overridden[0].measurement_window.override, true);
});

test('enriches requests with registry context and retry state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changequeue-view-'));
  fs.writeFileSync(
    path.join(root, 'DOMAINS_INDEX.md'),
    '| Domain | In use | TLDR |\n| example.com | ✅ | Example site purpose |\n'
  );
  const rows = view.enrichChangeRequests(
    root,
    [
      {
        request_id: '1',
        status: 'queued',
        site: 'example.com',
        next_attempt_at: '2099-01-01T00:00:00.000Z',
      },
    ],
    { max_concurrent: 2 },
    []
  );
  assert.equal(rows[0].site_context.description, 'Example site purpose');
  assert.equal(rows[0].queue_block.primary.code, 'retry_wait');
});

test('prefers machine-readable registry context and reports fairness escalation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changequeue-registry-'));
  fs.mkdirSync(path.join(root, 'registry'));
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    'sites:\n  example.com:\n    status: live\n    smoke_string: Registry purpose\n    capabilities: [site, analytics]\n'
  );
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const rows = view.enrichChangeRequests(
    root,
    [
      {
        request_id: '1',
        status: 'queued',
        site: 'example.com',
        created_at: '2026-09-26T10:00:00.000Z',
        delivery_mode: 'direct',
      },
    ],
    { max_concurrent: 1 },
    [{ site: 'example.com', state: 'measuring' }],
    now
  );
  assert.equal(rows[0].site_context.description, 'Registry purpose');
  assert.equal(rows[0].queue_block.escalated, true);
  assert.equal(rows[0].queue_block.blocked_since, '2026-09-26T10:00:00.000Z');
  assert.equal(view.queueMetrics(rows, now).by_reason.measurement_window, 1);
  assert.equal(
    view.buildQueueSnapshot(
      root,
      rows,
      { max_concurrent: 1 },
      [{ site: 'example.com', state: 'measuring' }],
      now
    ).queue_metrics.blocked,
    1
  );
});

test('unknown site context is safe and metrics distinguish eligible work', () => {
  const rows = view.enrichChangeRequests(
    fs.mkdtempSync(path.join(os.tmpdir(), 'changequeue-unknown-')),
    [
      {
        request_id: '1',
        status: 'queued',
        site: 'unknown.example',
        created_at: new Date().toISOString(),
      },
    ],
    { max_concurrent: 2 },
    []
  );
  assert.match(rows[0].site_context.description, /not in the fleet registry/);
  assert.equal(rows[0].queue_block.blocked, false);
  assert.equal(view.queueMetrics(rows).eligible, 1);
});

test('delivery metrics count deployed work by explicit rolling windows', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const rows = [
    { status: 'deployed', updated_at: '2026-09-27T11:00:00.000Z' },
    { status: 'verified', updated_at: '2026-09-26T12:00:00.000Z' },
    { status: 'failed', updated_at: '2026-09-25T12:00:00.000Z' },
    { status: 'deployed', updated_at: '2026-09-01T00:00:00.000Z' },
  ];
  const metrics = view.deliveryMetrics(rows, now);
  assert.equal(metrics.windows['24h'].shipped, 1);
  assert.equal(metrics.windows['2d'].shipped, 1);
  assert.equal(metrics.windows['5d'].failed, 1);
  assert.equal(metrics.windows.month_to_date.shipped, 2);
  assert.match(metrics.definition, /deployed/);
});
