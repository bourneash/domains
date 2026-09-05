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

test('classify suppresses routine AISStream reconnect warnings but preserves escalated errors', () => {
  const warning =
    'WARNING stream disconnected (no close frame received or sent); reconnecting in 1s (failure 1)';
  const escalated =
    'ERROR stream disconnected (no close frame received or sent); reconnecting in 16s (failure 5)';
  assert.equal(errorscan._classify(warning), null);
  assert.equal(errorscan._classify(escalated), 'error');
});

test('classify suppresses AISStream reconnect warnings behind the app\'s own asctime prefix', () => {
  // The actual line shape docker logs sees: consumer.py logs with
  // `%(asctime)s %(levelname)s %(message)s`, so WARNING is never at
  // position 0 of the parsed line.
  const warning =
    '2026-09-05 04:40:27,787 WARNING stream disconnected (no close frame received or sent); reconnecting in 1s (failure 1)';
  assert.equal(errorscan._classify(warning), null);
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

test('alert signature strips per-run noise but keeps the failing command distinct', () => {
  const line1 =
    'time="2026-08-30T20:06:01-04:00" level=error msg="error running command: exit status 18" ' +
    'iteration=196 job.command="bash ops/scripts/run-worker.sh engineer" job.position=1 job.schedule="6,36 * * * *"';
  const line2 =
    'time="2026-08-30T22:36:00-04:00" level=error msg="error running command: exit status 18" ' +
    'iteration=200 job.command="bash ops/scripts/run-worker.sh engineer" job.position=1 job.schedule="6,36 * * * *"';
  const line3 =
    'time="2026-08-30T21:52:00-04:00" level=error msg="error running command: exit status 18" ' +
    'iteration=195 job.command="bash ops/scripts/run-worker.sh scrape" job.position=13 job.schedule="14,44 * * * *"';
  const decisionFor = line => ({ label: 'repeated ERROR', trigger: { line } });
  assert.equal(errorscan._alertSignature(decisionFor(line1)), errorscan._alertSignature(decisionFor(line2)));
  assert.notEqual(errorscan._alertSignature(decisionFor(line1)), errorscan._alertSignature(decisionFor(line3)));
});

test('correlation collapses a fleet-wide signature into one notify and one all-clear', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-errorscan-correlate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  errorscan._resetForTest();

  const now = Date.now();
  const decision = { label: 'repeated ERROR', trigger: { line: 'shared root cause' } };
  const sig = errorscan._alertSignature(decision);

  const a = errorscan._noteCorrelation(root, sig, decision, 'site-a-cron', now);
  const b = errorscan._noteCorrelation(root, sig, decision, 'site-b-cron', now + 1);
  const c = errorscan._noteCorrelation(root, sig, decision, 'site-c-cron', now + 60_000);

  assert.equal(a.count, 1);
  assert.equal(a.justNotified, false);
  assert.equal(b.justNotified, false);
  assert.equal(c.count, 3);
  assert.equal(c.justNotified, true, 'the 3rd distinct site should cross the threshold');

  // A 4th site joining after notification folds in silently (no re-notify).
  const d = errorscan._noteCorrelation(root, sig, decision, 'site-d-cron', now + 120_000);
  assert.equal(d.justNotified, false);

  // Sites resolve one at a time; the incident only clears once ALL are gone.
  const resolveA = errorscan._resolveCorrelation(root, 'site-a-cron', now + 200_000);
  assert.equal(resolveA.inIncident, true);
  assert.equal(resolveA.wasNotified, true);
  assert.equal(resolveA.incidentCleared, false, 'b, c, d still open');

  errorscan._resolveCorrelation(root, 'site-b-cron', now + 200_001);
  errorscan._resolveCorrelation(root, 'site-c-cron', now + 200_002);
  const resolveD = errorscan._resolveCorrelation(root, 'site-d-cron', now + 200_003);
  assert.equal(resolveD.incidentCleared, true, 'last site resolving clears the incident');

  // Correlation state persists across a process restart.
  errorscan._resetForTest();
  const notInIncident = errorscan._resolveCorrelation(root, 'site-a-cron', now + 300_000);
  assert.equal(notInIncident.inIncident, false, 'incident was already cleared and persisted as such');
});

test('below-threshold correlation resolves quietly with no fleet notify', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-errorscan-correlate-below-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  errorscan._resetForTest();

  const now = Date.now();
  const decision = { label: 'repeated ERROR', trigger: { line: 'isolated failure' } };
  const sig = errorscan._alertSignature(decision);

  errorscan._noteCorrelation(root, sig, decision, 'site-a-cron', now);
  const only = errorscan._noteCorrelation(root, sig, decision, 'site-b-cron', now + 1);
  assert.equal(only.count, 2);
  assert.equal(only.justNotified, false, 'never crossed CORRELATE_MIN_SITES');

  const resolved = errorscan._resolveCorrelation(root, 'site-a-cron', now + 2);
  assert.equal(resolved.wasNotified, false, 'caller should fall back to a normal per-site recovery post');
});

test('stale correlations are pruned so an incident cannot live forever without an all-clear', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-errorscan-correlate-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  errorscan._resetForTest();

  const now = Date.now();
  const decision = { label: 'repeated ERROR', trigger: { line: 'stuck incident' } };
  const sig = errorscan._alertSignature(decision);
  errorscan._noteCorrelation(root, sig, decision, 'site-a-cron', now);

  errorscan._pruneStaleCorrelations(root, now + 25 * 60 * 60 * 1000);
  const after = errorscan._resolveCorrelation(root, 'site-a-cron', now + 25 * 60 * 60 * 1000 + 1);
  assert.equal(after.inIncident, false, 'stale incident should have been dropped');
});

test('unconfirmed correlation membership expires so unrelated same-signature flukes never fake a fleet-wide incident', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-errorscan-correlate-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  errorscan._resetForTest();

  const now = Date.now();
  const decision = { label: 'repeated ERROR', trigger: { line: 'coincidental same exit code' } };
  const sig = errorscan._alertSignature(decision);

  // site-a alerts, then over an hour later (past CORRELATE_WINDOW_MS) two
  // unrelated sites happen to alert on the same signature. site-a's stale
  // membership must not count toward the threshold.
  errorscan._noteCorrelation(root, sig, decision, 'site-a-cron', now);
  errorscan._noteCorrelation(root, sig, decision, 'site-b-cron', now + 65 * 60 * 1000);
  const c = errorscan._noteCorrelation(root, sig, decision, 'site-c-cron', now + 65 * 60 * 1000 + 1);

  assert.equal(c.count, 2, 'site-a should have aged out of the window');
  assert.equal(c.justNotified, false, 'only 2 sites within the window — below CORRELATE_MIN_SITES');
});

test('a failed Slack post is recorded instead of vanishing silently', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-errorscan-postfail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  errorscan._resetForTest();

  errorscan._recordPostFailure(root, {
    channel: 'domain-deeppenetrations-com',
    status: 200,
    error: 'channel_not_found',
    textPreview: ':white_check_mark: recovered',
  });

  const file = path.join(root, 'tools', 'fleet-dashboard', 'data', 'error-alert-post-failures.json');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].error, 'channel_not_found');
  assert.equal(persisted[0].channel, 'domain-deeppenetrations-com');
  assert.equal(typeof persisted[0].at, 'number');
});
