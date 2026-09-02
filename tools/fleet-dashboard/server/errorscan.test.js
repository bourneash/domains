'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const errorscan = require('./errorscan');

test('classify suppresses successful Astro route lines regardless of slug keywords', () => {
  const routes = [
    '18:10:44   ├─ /articles/iran-deal-israel-failure/index.html (+29ms) ',
    '18:11:09   ├─ /articles/ship-bab-el-mandeb-fatal/index.html (+29ms) ',
    '18:11:09   └─ /articles/zelenskyy-warning-cooperation/index.html (+29ms) ',
  ];
  for (const line of routes) assert.equal(errorscan._classify(line), null, line);
});

test('classify suppresses explicit zero-failure summaries but keeps real failures', () => {
  assert.equal(errorscan._classify('Done. 1 succeeded, 0 failed.'), null);
  assert.equal(errorscan._classify('Done. 0 succeeded, 1 failed.'), 'error');
  assert.equal(errorscan._classify('FATAL database unavailable'), 'crit');
});

test('classify suppresses scout-event lines even when a product title contains a crit/error keyword', () => {
  const panic =
    '[scout-event] {"event": "queued", "asin": "B098KN5STJ", "title": "Moose Master Penguin Panic", ' +
    '"category": "party-games", "price": "$19.99", "caption": "party game designed to destroy friendships"}';
  assert.equal(errorscan._classify(panic), null);
});

test('critical alert excerpt identifies the critical trigger, not a later warning', () => {
  const now = Date.now();
  const critical = { tsMs: now - 2000, level: 'crit', line: 'FATAL database unavailable' };
  const laterWarning = { tsMs: now - 1000, level: 'warn', line: 'WARNING retry scheduled' };
  const decision = errorscan._alertDecision(
    { scope: 'site', oneoff: false },
    [critical, laterWarning],
    null,
    now
  );
  assert.equal(decision.shouldAlert, true);
  assert.equal(decision.label, 'CRIT');
  assert.equal(decision.errorish1h, 1);
  assert.equal(decision.trigger, critical);
});

test('running one-off workers stay scannable but cannot emit duplicate Slack alerts', () => {
  const now = Date.now();
  const critical = [{ tsMs: now, level: 'crit', line: 'FATAL database unavailable' }];
  const oneoff = errorscan._alertDecision({ scope: 'site', oneoff: true }, critical, null, now);
  const persistent = errorscan._alertDecision(
    { scope: 'site', oneoff: false },
    critical,
    null,
    now
  );
  assert.equal(oneoff.shouldAlert, false);
  assert.equal(persistent.shouldAlert, true);
});

test('error threshold and cooldown still gate persistent-container alerts', () => {
  const now = Date.now();
  const errors = Array.from({ length: 5 }, (_, i) => ({
    tsMs: now - i,
    level: 'error',
    line: `error ${i}`,
  }));
  assert.equal(
    errorscan._alertDecision({ scope: 'site' }, errors.slice(0, 4), null, now).shouldAlert,
    false
  );
  assert.equal(errorscan._alertDecision({ scope: 'site' }, errors, null, now).shouldAlert, true);
  assert.equal(
    errorscan._alertDecision({ scope: 'site' }, errors, now - 1000, now).shouldAlert,
    false
  );
});

test('alert cooldown is claimed atomically and survives dashboard state reset', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-errorscan-cooldown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  errorscan._resetForTest();

  const now = Date.now();
  const container = { name: 'example-cron', scope: 'site', oneoff: false };
  const errors = Array.from({ length: 5 }, (_, i) => ({
    tsMs: now - i,
    level: 'error',
    line: `error ${i}`,
  }));

  assert.equal(errorscan._claimAlert(root, container, errors, now).shouldAlert, true);
  assert.equal(errorscan._claimAlert(root, container, errors, now + 1).shouldAlert, false);

  errorscan._resetForTest(); // simulate a panel process restart
  assert.equal(errorscan._claimAlert(root, container, errors, now + 2).shouldAlert, false);
});

test('an active alert emits one recovery transition and persists across restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-errorscan-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  errorscan._resetForTest();

  const now = Date.now();
  const container = { name: 'example-cron', scope: 'site', oneoff: false };
  const errors = Array.from({ length: 5 }, (_, i) => ({
    tsMs: now - i,
    level: 'error',
    line: `error ${i}`,
  }));

  assert.equal(errorscan._claimAlert(root, container, errors, now).shouldAlert, true);
  const recovered = errorscan._claimAlert(root, container, [], now + 1);
  assert.equal(recovered.shouldResolve, true);
  assert.equal(errorscan._claimAlert(root, container, [], now + 2).shouldResolve, false);

  errorscan._resetForTest();
  assert.equal(errorscan._claimAlert(root, container, [], now + 3).shouldResolve, false);
});
