'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dispatcher = require('./domain-dispatcher');
const reports = require('./domain-reports');

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-dispatch-'));
  fs.mkdirSync(path.join(value, 'sites', 'greatamericanlakes.com'), { recursive: true });
  fs.mkdirSync(reports.reportDir(value), { recursive: true });
  return value;
}

test('enqueues candidates once, prioritizes Great American Lakes, and caps concurrent leases', () => {
  const value = root();
  const report = {
    report_id: 'report-1',
    cadence: 'six_hour',
    generated_at: '2026-09-21T15:00:00.000Z',
    deep_dive_candidates: [
      { site: 'other.example', reasons: ['high_priority_seo_actions'] },
      { site: 'greatamericanlakes.com', reasons: ['owner_priority_site'] },
      { site: '3boobs.com', reasons: ['should_never_enter'] },
    ],
  };
  fs.writeFileSync(
    path.join(reports.reportDir(value), 'six_hour-report.json'),
    JSON.stringify(report)
  );
  const first = dispatcher.enqueueLatest(value, { now: new Date('2026-09-21T15:01:00.000Z') });
  assert.equal(first.added.length, 2);
  assert.equal(dispatcher.enqueueLatest(value).added.length, 0);
  const claimed = dispatcher.claimNext(value, { now: new Date('2026-09-21T15:02:00.000Z') });
  assert.equal(claimed.site, 'greatamericanlakes.com');
  const second = dispatcher.claimNext(value, { now: new Date('2026-09-21T15:03:00.000Z') });
  assert.equal(second.site, 'other.example');
  assert.equal(
    dispatcher.claimNext(value, {
      now: new Date('2026-09-21T15:03:00.000Z'),
      maxConcurrent: 2,
    }),
    null
  );
  dispatcher.finish(value, claimed.job_id, { ok: true, now: new Date('2026-09-21T15:04:00.000Z') });
  assert.equal(dispatcher.summary(value).completed, 1);
});

test('never claims an excluded site', () => {
  const value = root();
  const state = {
    jobs: [
      {
        job_id: 'bad',
        site: '3boobs.com',
        status: 'queued',
        attempts: 0,
        requested_at: new Date().toISOString(),
      },
    ],
  };
  dispatcher.writeState(value, state);
  assert.equal(dispatcher.claimNext(value), null);
});
