'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./eventstore');
const productivity = require('./productivity-program');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-productivity-'));
  return store.open(root, { file: path.join(root, 'events.sqlite') });
}

test('productivity snapshots separate treatment and control output by lane', () => {
  const db = fixture();
  const now = new Date().toISOString();
  db.createChangeRequest({
    request_id: 'treatment-request',
    site: 'treatment.example',
    title: 'Refresh conversion layout',
    body: 'Ship the approved design CTA improvement with a preview and rollback.',
    category: 'design',
    assigned_role: 'engineer',
    status: 'verified',
    created_at: now,
  });
  db.createImprovement({
    site: 'treatment.example',
    source: 'fleet-dashboard',
    source_id: 'treatment-request',
    title: 'Validated design run',
    state: 'measuring',
    measurement_due: '2026-10-11',
    baseline: { captured_at: now },
    validation: { passed: true },
  });
  db.createChangeRequest({
    site: 'control.example',
    title: 'SEO notes',
    body: 'Existing baseline only',
    category: 'seo',
    assigned_role: 'seo-analyst',
    status: 'queued',
    created_at: now,
  });
  const result = productivity.snapshot(db, {
    from: new Date(Date.now() - 60_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    treatment_sites: ['treatment.example'],
    control_sites: ['control.example'],
  });
  assert.equal(result.treatment.requests_completed, 1);
  assert.equal(result.treatment.valuable_outputs, 1);
  assert.equal(result.treatment.measurement_ready_outputs, 1);
  assert.equal(result.treatment.design_items, 1);
  assert.equal(result.control.requests_completed, 0);
  db.close();
});

test('pilot evaluation requires measurable treatment lift and guardrails', () => {
  const baseline = {
    treatment: { shipped_output: 0, requests_failed: 0 },
    control: { shipped_output: 0 },
  };
  const passing = productivity.evaluate(baseline, {
    treatment: {
      shipped_output: 4,
      output_per_site: 2,
      requests_created: 4,
      requests_completed: 4,
      requests_failed: 0,
      valuable_outputs: 4,
      measurement_ready_outputs: 4,
    },
    control: { shipped_output: 1, output_per_site: 0.5 },
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.guardrails.measurement_required, true);
  const failing = productivity.evaluate(baseline, {
    treatment: {
      shipped_output: 1,
      output_per_site: 0.5,
      requests_created: 2,
      requests_completed: 1,
      requests_failed: 0,
      valuable_outputs: 1,
      measurement_ready_outputs: 0,
    },
    control: { shipped_output: 2, output_per_site: 1 },
  });
  assert.equal(failing.passed, false);
  assert.ok(failing.reasons.length >= 2);
});

test('pilot evaluation stays inconclusive before the minimum observation window', () => {
  const result = productivity.evaluate(
    { treatment: { shipped_output: 10 }, control: { shipped_output: 6 } },
    {
      from: '2026-09-27T00:00:00.000Z',
      to: '2026-09-28T00:00:00.000Z',
      treatment: {
        shipped_output: 2,
        output_per_site: 0.67,
        requests_created: 10,
        requests_completed: 2,
      },
      control: { shipped_output: 0, output_per_site: 0 },
    }
  );
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.passed, null);
  assert.equal(result.observation_days, 1);
  assert.match(result.reasons[0], /measurement window is incomplete/);
});

test('treatment batch creates one idempotent design and growth action per treatment site', () => {
  const batch = productivity.treatmentBatch({
    pilot_id: 'pilot-123',
    treatment_sites: ['GreatAmericanLakes.com', 'allthingsmasonic.com'],
  });
  assert.equal(batch.length, 4);
  assert.deepEqual(
    batch.map(row => row.action_key),
    [
      'productivity-pilot:pilot-123:design:greatamericanlakes.com',
      'productivity-pilot:pilot-123:growth-revenue:greatamericanlakes.com',
      'productivity-pilot:pilot-123:design:allthingsmasonic.com',
      'productivity-pilot:pilot-123:growth-revenue:allthingsmasonic.com',
    ]
  );
  assert.equal(batch.filter(row => row.lane === 'finish-sites').length, 2);
  assert.equal(batch.filter(row => row.lane === 'growth-revenue').length, 2);
});

test('private-preview policy blocks growth work but permits design work', () => {
  const privatePreviewSites = ['3BOOBS.com'];
  assert.deepEqual(
    productivity.siteCategoryEligibility('3boobs.com', 'seo', { privatePreviewSites }),
    {
      eligible: false,
      reason:
        'private-preview site is not eligible for SEO, affiliate, or revenue work until launch',
    }
  );
  assert.deepEqual(
    productivity.siteCategoryEligibility('3boobs.com', 'design', { privatePreviewSites }),
    { eligible: true, reason: null }
  );
});

test('pilot cohort validation rejects excluded, unknown, and overlapping sites', () => {
  const invalid = productivity.validatePilotCohorts(
    {
      treatment_sites: ['3BOOBS.com', 'known.example'],
      control_sites: ['known.example', 'missing.example'],
    },
    { known_sites: ['3boobs.com', 'known.example'] }
  );
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' '), /excluded site/);
  assert.match(invalid.errors.join(' '), /overlap/);
  assert.match(invalid.errors.join(' '), /unknown site/);
  const valid = productivity.validatePilotCohorts(
    { treatment_sites: ['known.example'], control_sites: ['other.example'] },
    { known_sites: ['known.example', 'other.example'] }
  );
  assert.equal(valid.valid, true);
});

test('queue readiness excludes sites with active requests or improvement windows', () => {
  const db = fixture();
  db.createChangeRequest({
    site: 'busy-request.example',
    title: 'Queued work',
    body: 'bounded',
    status: 'queued',
    created_at: new Date().toISOString(),
  });
  db.createImprovement({
    site: 'busy-measurement.example',
    source: 'test',
    title: 'Measured work',
    state: 'measuring',
    measurement_due: '2026-10-08',
  });
  assert.deepEqual(
    productivity.queueReadiness(db, [
      'busy-request.example',
      'busy-measurement.example',
      'ready.example',
    ]),
    {
      sites: ['busy-request.example', 'busy-measurement.example', 'ready.example'],
      ready_sites: ['ready.example'],
      blocked_sites: [
        {
          site: 'busy-request.example',
          reason: 'active change request: queued',
          measurement_due: null,
        },
        {
          site: 'busy-measurement.example',
          reason: 'active improvement: measuring',
          measurement_due: '2026-10-08',
        },
      ],
    }
  );
  db.close();
});

test('productivity output does not count pre-existing work reconciled during the window', () => {
  const db = fixture();
  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const old = db.createExecutiveWorkItem({
    work_id: 'old-work',
    site: 'treatment.example',
    title: 'Pre-existing work',
    status: 'done',
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  assert.equal(old.status, 'done');
  db.createExecutiveWorkItem({
    work_id: 'new-work',
    site: 'treatment.example',
    title: 'Pilot work',
    status: 'done',
    created_at: new Date().toISOString(),
  });
  db.createExecutiveWorkItem({
    work_id: 'reconciled-failure',
    source_type: 'failed-change-request',
    source_id: 'failed-request',
    site: 'treatment.example',
    title: 'Closed repair projection',
    status: 'done',
    created_at: new Date().toISOString(),
  });
  const result = productivity.snapshot(db, {
    from,
    to,
    treatment_sites: ['treatment.example'],
    control_sites: [],
  });
  assert.equal(result.treatment.work_completed, 1);
  db.close();
});

test('pilot measurement finalizes at end time and persists the decision', () => {
  const db = fixture();
  const start = '2026-09-01T00:00:00.000Z';
  const end = '2026-09-08T00:00:00.000Z';
  const pilot = db.createProductivityPilot({
    pilot_id: 'pilot-finalize',
    name: 'Finalize test',
    treatment_sites: ['treatment.example'],
    control_sites: ['control.example'],
    start_at: start,
    end_at: end,
    baseline: {
      treatment: { shipped_output: 0, requests_failed: 0 },
      control: { shipped_output: 0, requests_failed: 0 },
    },
  });
  db.updateProductivityPilot(pilot.pilot_id, { status: 'active', baseline: pilot.baseline });
  db.createChangeRequest({
    request_id: 'final-request',
    site: 'treatment.example',
    title: 'Validated design change',
    body: 'Design improvement',
    category: 'design',
    status: 'verified',
    created_at: '2026-09-02T00:00:00.000Z',
  });
  db.createImprovement({
    site: 'treatment.example',
    source: 'productivity-pilot',
    source_id: 'final-request',
    title: 'Validated output',
    state: 'measuring',
    measurement_due: end,
    baseline: { captured_at: start },
    validation: { passed: true },
  });
  const result = productivity.recordPilotMeasurement(db, db.getProductivityPilot(pilot.pilot_id), {
    now: new Date(end),
  });
  assert.equal(result.final, true);
  assert.equal(result.pilot.status, 'needs-adjustment');
  assert.equal(db.listProductivitySnapshots(pilot.pilot_id, { limit: 1 })[0].phase, 'evaluation');
  assert.equal(db.getProductivityPilot(pilot.pilot_id).evaluation.status, 'needs-adjustment');
  db.close();
});
