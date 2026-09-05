'use strict';

// Fleet-wide error/warning log scanner. Background poller tails every
// in-repo container's `docker logs` (via containers.list, so it's guardrailed
// to the domains repo automatically), classifies each new line as
// crit/error/warn, and keeps a rolling per-container buffer. This is the
// "what's broken right now" rollup — nobody has to open Containers and read
// raw tails one at a time to notice a site is erroring.
//
// Read-only: only `docker logs`, never a write/restart/exec.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const containers = require('./containers');

const POLL_MS = 3 * 60 * 1000; // scan cadence
const CONCURRENCY = 4; // parallel `docker logs` fetches
const RETENTION_MS = 26 * 60 * 60 * 1000; // keep matches this long (covers the 24h rollup + slack)
const MAX_LINES_PER_CONTAINER = 3000; // hard cap so one chatty container can't blow up memory
const FIRST_SCAN_SINCE = '24h'; // backfill window the first time we see a container
const FIRST_SCAN_TAIL = '5000'; // bound the backfill cost for a chatty container's history

const ALERT_ERROR_1H_THRESHOLD = 5; // "every run of this cron is failing" signal
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // don't re-alert the same container within this window

// Fleet-wide correlation: shared infra (the worker image, a broker, a VPN
// pop) breaking hits every site's cron on its own schedule offset, so the
// same root cause shows up as N per-site alerts minutes to an hour apart
// instead of one recognizable event (2026-08-30: a docker prune wiped
// fleet-site-worker:latest and 22 sites alerted individually, one of which
// reached Slack). Group same-signature alerts within the window; once
// CORRELATE_MIN_SITES distinct sites share a signature, collapse them into
// one #fleet-ops incident post and suppress further per-site noise for that
// signature — individual per-site alerting for the first sites is
// unavoidable (you can't know it's fleet-wide until the Nth one), but
// everything past the threshold, and the eventual all-clear, is one message.
const CORRELATE_MIN_SITES = 3;
const CORRELATE_WINDOW_MS = 60 * 60 * 1000; // staggered cron offsets across sites can be up to ~1h apart
const CORRELATE_STALE_MS = 24 * 60 * 60 * 1000; // safety net: drop an incident whose sites never resolve (e.g. container removed)

// Known deviations from the `domain-<slug-with-dashes>` channel-naming
// convention every other site follows (see tools/role-notify/notify_role.py's
// --channel-env usage) — keyed by slug -> the .env var to read instead, so a
// channel rename in .env is picked up automatically. Add an entry only when a
// site's channel doesn't follow the default pattern.
const CHANNEL_ENV_OVERRIDE = { '0daynews.com': 'SLACK_CHANNEL_0DAYNEWS' };

// Order matters: crit beats error beats warn for a given line.
const CRIT_RE = /\b(panic|fatal|out of memory|oom.?killed|segfault)\b/i;
const ERROR_RE = /\b(error|exception|traceback|failed|failure)\b/i;
const WARN_RE = /\bwarn(?:ing)?\b/i;

// Fleet-wide boilerplate that would otherwise drown real signal: supercronic
// (the cron scheduler every site's cron container runs) logs a "warning" for
// every single child process it reaps, even on a clean exit (wstatus=0). That
// alone is the majority of every cron container's log volume. A nonzero
// wstatus (an actual failed job) still matches — only the clean-exit case is
// suppressed. Add more entries here as other fleet-wide noise turns up.
const SUPPRESS_RE = [
  // AISStream reconnects automatically after ordinary upstream TCP drops. The
  // line contains "failure" as a retry counter, but is logged at WARNING.
  // Not anchored to line start: the app's own `%(asctime)s %(levelname)s`
  // format puts a timestamp before WARNING, so `docker logs` lines never
  // start with the level (2026-09-05: this anchor never matched in
  // production, so every reconnect's "(failure N)" counter tripped
  // ERROR_RE's \bfailure\b and paged marineactivity-aisstream ~24x/day).
  /\bWARNING\s+stream disconnected\b.*reconnecting in \d+s \(failure \d+\)/i,
  /reaper cleanup: pid=\d+, wstatus=0\b/i,
  /\bnon-fatal\b/i, // "\bfatal\b" matches inside "non-fatal" — the negation flips the meaning
  // Astro prints every successfully generated route. Article slugs are content,
  // not status text, so names containing "warning", "failure", or "fatal" must
  // never become incidents.
  /^\d{2}:\d{2}:\d{2}\s+[├└]─\s+\/\S+\s+\(\+\d+(?:\.\d+)?ms\)\s*$/i,
  // Successful batch summaries still contain the word "failed". Preserve
  // nonzero failures as signal while dropping the explicit zero-failure case.
  /\bDone\.\s+\d+\s+succeeded,\s+0\s+failed\.\s*$/i,
  // Nano Banana's shared CloakBrowser profile only allows one fleet-wide
  // generation at a time (see tools/media-gen). media_gen_client.py already
  // retries-and-waits on this 429 before giving up, and every caller falls
  // back to ComfyUI on top of that — by the time this text is logged, the
  // guide/article it belongs to has already been generated successfully via
  // the fallback. Expected contention, not an incident.
  /another Nano Banana generation is already running fleet-wide/i,
  // SecurityScanner's structlog executor logs scan_state_transitioned at
  // [info] with the scan's result (including sub-tool stdout/stderr) dumped
  // verbatim into `metadata`. Grype/Syft's own diagnostic chatter — e.g.
  // "WARN no explicit name and version provided for directory source" — gets
  // swept in by WARN_RE even though the scan itself completed cleanly and
  // the executor already classified the line as info. Trust the app's own
  // level over a nested tool's WARN string appearing inside a JSON blob.
  /^\[info\s*\]\s*scan_state_transitioned\b.*\bWARN\b/i,
  // product-scout's [scout-event] lines are structured JSON carrying
  // arbitrary Amazon product titles/captions, not status text — e.g. a
  // "Penguin Panic" party game title matches CRIT_RE's "panic", and a
  // "friendship-destroying" caption matches ERROR_RE's "failure"-family
  // words purely by coincidence of subject matter (2026-09-02: weirdassstuff
  // paged on "Moose Master Penguin Panic" queued for publish, exit=0).
  /^\[scout-event\]\s*\{/i,
];

function sh(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { timeout: 20000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

// id -> { name, slug, kind, scope, running, sinceIso, matches: [{tsMs, level, line}], lastAlertAt }
let STATE = new Map();
let lastSweep = 0;
let ALERT_COOLDOWNS = new Map();
let alertCooldownRoot = null;
let ACTIVE_ALERTS = new Set();
let alertStateRoot = null;
let sweepInFlight = null;
// signature -> { sites: { [containerName]: firstAlertAtMs }, notifiedAt: ms|null, firstAt, lastAt, label, sampleLine }
let CORRELATED_INCIDENTS = new Map();
let correlatedRoot = null;

function alertCooldownFile(root) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'error-alert-cooldowns.json');
}

function loadAlertCooldowns(root) {
  if (alertCooldownRoot === root) return;
  alertCooldownRoot = root;
  ALERT_COOLDOWNS = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(alertCooldownFile(root), 'utf8'));
    const oldestUseful = Date.now() - ALERT_COOLDOWN_MS;
    for (const [key, value] of Object.entries(parsed || {})) {
      const ts = Number(value);
      if (Number.isFinite(ts) && ts >= oldestUseful) ALERT_COOLDOWNS.set(key, ts);
    }
  } catch {
    /* first run, missing file, or corrupt best-effort state: start empty */
  }
}

function persistAlertCooldowns(root) {
  const file = alertCooldownFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(ALERT_COOLDOWNS), null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort state only */
    }
  }
}

function alertStateFile(root) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'error-alert-state.json');
}

function loadAlertState(root) {
  if (alertStateRoot === root) return;
  alertStateRoot = root;
  ACTIVE_ALERTS = new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(alertStateFile(root), 'utf8'));
    for (const key of Array.isArray(parsed) ? parsed : []) {
      if (typeof key === 'string' && key) ACTIVE_ALERTS.add(key);
    }
  } catch {
    /* first run, missing, or corrupt best-effort state: start empty */
  }
}

function persistAlertState(root) {
  const file = alertStateFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify([...ACTIVE_ALERTS].sort(), null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort state only */
    }
  }
}

const MAX_POST_FAILURES = 30;
let POST_FAILURES = [];
let postFailuresRoot = null;

function postFailuresFile(root) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'error-alert-post-failures.json');
}

function loadPostFailures(root) {
  if (postFailuresRoot === root) return;
  postFailuresRoot = root;
  POST_FAILURES = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(postFailuresFile(root), 'utf8'));
    if (Array.isArray(parsed)) POST_FAILURES = parsed.slice(-MAX_POST_FAILURES);
  } catch {
    /* first run, missing, or corrupt best-effort state: start empty */
  }
}

function persistPostFailures(root) {
  const file = postFailuresFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(POST_FAILURES, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort state only */
    }
  }
}

// A Slack post silently failing (bad token, wrong/renamed channel, rate limit)
// used to mean nobody ever saw a threshold alert OR its all-clear, with zero
// trace anywhere it had even been attempted (2026-09-02: deeppenetrations-cron's
// resolve fired — ACTIVE_ALERTS/error-alert-state.json show it cleared — but
// no all-clear ever reached Slack, and there was nothing to say why). Record
// every failed attempt here (never throw — a broken notify must still never
// break the sweep) so the dashboard can show "resolved, but the Slack post
// failed" instead of indistinguishable silence.
function recordPostFailure(root, entry) {
  loadPostFailures(root);
  POST_FAILURES.push({ at: Date.now(), ...entry });
  if (POST_FAILURES.length > MAX_POST_FAILURES) POST_FAILURES = POST_FAILURES.slice(-MAX_POST_FAILURES);
  persistPostFailures(root);
}

function correlatedFile(root) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'error-alert-correlated.json');
}

function loadCorrelatedIncidents(root) {
  if (correlatedRoot === root) return;
  correlatedRoot = root;
  CORRELATED_INCIDENTS = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(correlatedFile(root), 'utf8'));
    for (const [sig, rec] of Object.entries(parsed || {})) {
      if (!rec || typeof rec !== 'object') continue;
      CORRELATED_INCIDENTS.set(sig, { ...rec, sites: { ...(rec.sites || {}) } });
    }
  } catch {
    /* first run, missing file, or corrupt best-effort state: start empty */
  }
}

function persistCorrelatedIncidents(root) {
  const file = correlatedFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(CORRELATED_INCIDENTS), null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort state only */
    }
  }
}

// Identify WHAT failed, stripped of per-site/per-run noise (iteration count,
// schedule offset, timestamp), so the same underlying failure across many
// sites collapses to one signature. `msg=` and `job.command=` are the parts
// of a supercronic error line that describe the failure itself.
function alertSignature(decision) {
  const line = (decision.trigger && decision.trigger.line) || '';
  const msg = (line.match(/msg="([^"]*)"/) || [])[1] || line.slice(0, 120);
  const cmd = (line.match(/job\.command="([^"]*)"/) || [])[1] || '';
  return `${decision.label}|${msg}|${cmd}`.slice(0, 300);
}

function fleetChannel(envText) {
  return envVar(envText, 'SLACK_CHANNEL_FLEET') || '#fleet-ops';
}

async function postFleetSlack(root, text, color = 'danger') {
  const envText = loadEnvText(root);
  const token = envVar(envText, 'SLACK_BOT_TOKEN');
  if (!token) return;
  const channel = fleetChannel(envText);
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, attachments: [{ color, text }] }),
      signal: AbortSignal.timeout(10000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || !body?.ok) {
      recordPostFailure(root, {
        channel,
        status: res.status,
        error: body?.error || `http_${res.status}`,
        textPreview: text.slice(0, 200),
      });
    }
  } catch (err) {
    // Never throw — see comment above recordPostFailure — but never swallow
    // silently either.
    recordPostFailure(root, { channel, status: null, error: String(err?.message || err), textPreview: text.slice(0, 200) });
  }
}

// Record this container's alert against its signature's incident. Returns
// { record, count, justNotified } — count is the distinct-site tally used to
// decide whether this crosses CORRELATE_MIN_SITES this call.
function noteCorrelation(root, sig, decision, siteName, now) {
  loadCorrelatedIncidents(root);
  let rec = CORRELATED_INCIDENTS.get(sig);
  if (!rec) {
    rec = { sites: {}, notifiedAt: null, firstAt: now, lastAt: now, label: decision.label, sampleLine: (decision.trigger && decision.trigger.line) || '' };
    CORRELATED_INCIDENTS.set(sig, rec);
  }
  // Before a fleet-wide incident is confirmed, membership should only count
  // sites whose alert is recent enough to plausibly share a cause — without
  // this, isolated same-signature failures days apart (a flaky role that
  // just happens to log the same exit code) would eventually accumulate
  // past CORRELATE_MIN_SITES and fire a false "fleet-wide" alert. Once
  // confirmed (notifiedAt set), membership is real and stays until resolved.
  if (!rec.notifiedAt) {
    for (const [site, at] of Object.entries(rec.sites)) {
      if (now - at > CORRELATE_WINDOW_MS) delete rec.sites[site];
    }
  }
  rec.lastAt = now;
  if (!(siteName in rec.sites)) rec.sites[siteName] = now;
  const count = Object.keys(rec.sites).length;
  let justNotified = false;
  if (!rec.notifiedAt && count >= CORRELATE_MIN_SITES) {
    rec.notifiedAt = now;
    justNotified = true;
  }
  persistCorrelatedIncidents(root);
  return { record: rec, count, justNotified };
}

// A site recovered. If it belongs to an active incident, fold it out there
// instead of (or in addition to, once the incident is fully clear) posting a
// per-site recovery. Returns { inIncident, incidentSig, incidentCleared, record }.
function resolveCorrelation(root, siteName, now) {
  loadCorrelatedIncidents(root);
  for (const [sig, rec] of CORRELATED_INCIDENTS) {
    if (!(siteName in rec.sites)) continue;
    delete rec.sites[siteName];
    const remaining = Object.keys(rec.sites).length;
    const wasNotified = Boolean(rec.notifiedAt);
    let incidentCleared = false;
    if (remaining === 0) {
      CORRELATED_INCIDENTS.delete(sig);
      incidentCleared = wasNotified;
    }
    persistCorrelatedIncidents(root);
    return { inIncident: true, incidentSig: sig, incidentCleared, wasNotified, remaining, record: rec };
  }
  return { inIncident: false };
}

// Safety net: an incident's remaining sites can get stuck (container removed,
// a resolve missed) — drop anything that's gone stale rather than let a
// #fleet-ops incident live forever with no all-clear.
function pruneStaleCorrelations(root, now) {
  loadCorrelatedIncidents(root);
  let changed = false;
  for (const [sig, rec] of CORRELATED_INCIDENTS) {
    if (now - rec.lastAt > CORRELATE_STALE_MS) {
      CORRELATED_INCIDENTS.delete(sig);
      changed = true;
    }
  }
  if (changed) persistCorrelatedIncidents(root);
}

// Same "read .env directly" approach deployhealth.js uses for CF creds — the
// panel's compose environment doesn't forward SLACK_BOT_TOKEN, so this is the
// only way to reach it from inside the container.
function loadEnvText(root) {
  try {
    return fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return '';
  }
}
function envVar(envText, key) {
  const m = envText.match(new RegExp('^\\s*' + key + '\\s*=\\s*["\']?([^\\s"\'#]+)', 'm'));
  return m ? m[1] : null;
}
function channelForSlug(envText, slug) {
  const overrideKey = CHANNEL_ENV_OVERRIDE[slug];
  const override = overrideKey && envVar(envText, overrideKey);
  return override || `domain-${slug.replace(/\./g, '-')}`;
}

// Threshold alert → the site's Slack channel. Mirrors every other notifier in
// this repo: silently no-ops without SLACK_BOT_TOKEN, never throws (a broken
// notify must never break the sweep) — but a failed attempt is now recorded
// (recordPostFailure) instead of vanishing with no trace.
async function postSlackAlert(root, slug, text, color = 'danger') {
  const envText = loadEnvText(root);
  const token = envVar(envText, 'SLACK_BOT_TOKEN');
  if (!token) return;
  const channel = channelForSlug(envText, slug);
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, attachments: [{ color, text }] }),
      signal: AbortSignal.timeout(10000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || !body?.ok) {
      recordPostFailure(root, {
        channel,
        status: res.status,
        error: body?.error || `http_${res.status}`,
        textPreview: text.slice(0, 200),
      });
    }
  } catch (err) {
    recordPostFailure(root, { channel, status: null, error: String(err?.message || err), textPreview: text.slice(0, 200) });
  }
}

function classify(text) {
  if (SUPPRESS_RE.some(re => re.test(text))) return null;
  if (CRIT_RE.test(text)) return 'crit';
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  return null;
}

// `docker logs --timestamps` prefixes each line "2024-01-01T00:00:00.123456789Z msg".
// Truncate the fraction to ms so the result is both a valid Date input and a
// safe --since value to hand back to docker on the next sweep.
function parseLine(raw) {
  const m = raw.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z\s(.*)$/s);
  if (!m) return null;
  const frac = m[2] ? m[2].slice(1, 4).padEnd(3, '0') : '000';
  const tsIso = `${m[1]}.${frac}Z`;
  const tsMs = Date.parse(tsIso);
  if (Number.isNaN(tsMs)) return null;
  return { tsMs, tsIso, text: m[3] };
}

function alertDecision(c, recent1h, prevAlertAt, now) {
  const crits = recent1h.filter(m => m.level === 'crit');
  const errorish = recent1h.filter(m => m.level === 'error' || m.level === 'crit');
  const hasCrit1h = crits.length > 0;
  const errorish1h = errorish.length;
  // A CRIT alert should show the latest critical line that explains its label,
  // even when a later warning was logged. Threshold ERROR alerts show the latest
  // error/critical line that contributed to the count.
  const trigger = hasCrit1h ? crits[crits.length - 1] : errorish[errorish.length - 1];
  const label = hasCrit1h ? 'CRIT' : 'repeated ERROR';
  // Running Compose one-offs are attached to their parent scheduler, so their
  // output is already present in the persistent cron container's log. Keep them
  // visible in the dashboard, but alert only from persistent site containers to
  // avoid duplicate Slack incidents and per-container cooldown resets.
  const alertEligible = c.scope === 'site' && !c.oneoff;
  const overThreshold = hasCrit1h || errorish1h >= ALERT_ERROR_1H_THRESHOLD;
  const outsideCooldown = !prevAlertAt || now - prevAlertAt > ALERT_COOLDOWN_MS;
  return {
    hasCrit1h,
    errorish1h,
    trigger,
    label,
    alertEligible,
    shouldAlert: alertEligible && overThreshold && outsideCooldown,
  };
}

// Claim the alert cooldown synchronously before the async Slack post. The
// stable container name survives Compose recreation, while the persisted
// ledger survives dashboard restarts. This also closes the race where two
// overlapping slow sweeps both captured the same stale STATE entry before
// either docker-logs call returned.
function claimAlert(root, c, recent1h, now) {
  loadAlertCooldowns(root);
  loadAlertState(root);
  const key = c.name || `${c.slug || 'unknown'}:${c.kind || 'container'}`;
  const prevAlertAt = ALERT_COOLDOWNS.get(key) || null;
  const decision = alertDecision(c, recent1h, prevAlertAt, now);
  const shouldResolve =
    decision.alertEligible && ACTIVE_ALERTS.has(key) && !decision.hasCrit1h && decision.errorish1h < ALERT_ERROR_1H_THRESHOLD;
  if (decision.shouldAlert) {
    ALERT_COOLDOWNS.set(key, now);
    persistAlertCooldowns(root);
    ACTIVE_ALERTS.add(key);
    persistAlertState(root);
  } else if (shouldResolve) {
    ACTIVE_ALERTS.delete(key);
    persistAlertState(root);
  }
  return {
    ...decision,
    shouldResolve,
    lastAlertAt: decision.shouldAlert ? now : prevAlertAt,
  };
}

async function scanOne(root, c) {
  const prev = STATE.get(c.id);
  const args = ['logs', '--timestamps'];
  if (prev) args.push('--since', prev.sinceIso);
  else args.push('--since', FIRST_SCAN_SINCE, '--tail', FIRST_SCAN_TAIL);
  args.push(c.id);
  const r = await sh('docker', args);
  const raw = `${r.stdout}${r.stderr}`;
  const parsed = raw.split('\n').filter(Boolean).map(parseLine).filter(Boolean);

  const prevSinceMs = prev ? Date.parse(prev.sinceIso) : null;
  const matches = prev ? prev.matches.slice() : [];
  let sinceIso = prev ? prev.sinceIso : null;
  for (const { tsMs, tsIso, text } of parsed) {
    if (!sinceIso || tsMs > Date.parse(sinceIso)) sinceIso = tsIso;
    if (prevSinceMs != null && tsMs <= prevSinceMs) continue; // re-fetched boundary line, already counted
    const level = classify(text);
    if (level) matches.push({ tsMs, level, line: text.slice(0, 2000) });
  }

  const now = Date.now();
  const cutoff = now - RETENTION_MS;
  const pruned = matches.filter(m => m.tsMs >= cutoff);
  const trimmed =
    pruned.length > MAX_LINES_PER_CONTAINER ? pruned.slice(-MAX_LINES_PER_CONTAINER) : pruned;

  // Threshold alert: a crit-level line, or a sustained run of error/crit
  // lines in the last hour (e.g. a cron job failing every single iteration).
  // Site-scoped only — tool containers (secscan, datahub, …) have no
  // domain-<slug> Slack channel to post to. Cooldown-gated like the watchdog's
  // escalate(), so a chronic failure alerts once per window, not every sweep.
  const h1 = now - 60 * 60 * 1000;
  const recent1h = trimmed.filter(m => m.tsMs >= h1);
  const decision = claimAlert(root, c, recent1h, now);

  STATE.set(c.id, {
    name: c.name,
    slug: c.slug,
    kind: c.kind,
    scope: c.scope,
    running: c.running,
    sinceIso: sinceIso || new Date().toISOString(),
    matches: trimmed,
    lastAlertAt: decision.lastAlertAt || null,
  });

  if (decision.shouldAlert) {
    const sig = alertSignature(decision);
    const { record, count, justNotified } = noteCorrelation(root, sig, decision, c.name, now);
    if (count >= CORRELATE_MIN_SITES) {
      // Fleet-wide incident: this signature has hit enough distinct sites to
      // be the same root cause, not a per-site fluke. One #fleet-ops post
      // covers it (posted once, on the transition) — no per-site ping.
      if (justNotified) {
        const text =
          `:rotating_light: *Fleet-wide ${record.label}* — ${count} site(s) sharing one signature\n` +
          `Sites: ${Object.keys(record.sites).sort().join(', ')}\n` +
          `Trigger: \`${(record.sampleLine || '').slice(0, 300)}\`\n` +
          'Likely shared infra (worker image, broker, network) — check one site, fix once. ' +
          'Fleet Dashboard → Errors tab for detail. Further sites hitting this signature will be folded in silently; ' +
          'one all-clear posts here once every affected site recovers.';
        postFleetSlack(root, text).catch(() => {});
      }
    } else {
      const text =
        `:rotating_light: *${c.name}* — ${decision.label} (${decision.errorish1h} error/crit line(s) in the last hour)\n` +
        `Trigger: \`${((decision.trigger && decision.trigger.line) || '').slice(0, 300)}\`\n` +
        'Fleet Dashboard → Errors tab for detail.';
      postSlackAlert(root, c.slug, text).catch(() => {});
    }
  }
  if (decision.shouldResolve) {
    const corr = resolveCorrelation(root, c.name, now);
    if (corr.inIncident && corr.wasNotified) {
      if (corr.incidentCleared) {
        const text =
          `:white_check_mark: *Fleet-wide ${corr.record.label}* — recovered; all affected sites clear\n` +
          `Recovered: ${Object.keys(corr.record.sites).length ? Object.keys(corr.record.sites).sort().join(', ') : c.name}`;
        postFleetSlack(root, text, 'good').catch(() => {});
      }
      // else: still waiting on other sites in this incident — stay silent for this one
    } else {
      const text =
        `:white_check_mark: *${c.name}* — recovered; error condition cleared\n` +
        'No critical or repeated error lines remain in the last hour.';
      postSlackAlert(root, c.slug, text, 'good').catch(() => {});
    }
  }
}

async function sweep(root) {
  loadAlertState(root); // so rollup()'s active-alert flags are populated even before any alert fires this process
  loadPostFailures(root); // ditto for postFailures — otherwise a restart hides prior failures until the next one
  const list = await containers.list(root);
  const seen = new Set(list.map(c => c.id));
  // Drop containers that no longer exist — a restart/rebuild gets a fresh id,
  // so its predecessor's history simply ages out rather than being carried over.
  for (const id of STATE.keys()) if (!seen.has(id)) STATE.delete(id);

  const queue = list.slice();
  async function worker() {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        await scanOne(root, c);
      } catch {
        /* one bad container shouldn't kill the sweep */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  pruneStaleCorrelations(root, Date.now());
  lastSweep = Date.now();
}

// Start the background timer (immediate first sweep, then every POLL_MS). The
// timer is unref'd so it never holds the process open on shutdown.
function start(root) {
  const tick = () => {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = sweep(root)
      .catch(() => {
        /* swallow; rollup simply goes stale */
      })
      .finally(() => {
        sweepInFlight = null;
      });
    return sweepInFlight;
  };
  tick();
  const t = setInterval(tick, POLL_MS);
  if (t.unref) t.unref();
}

// Per-container rollup for the dashboard: 1h/24h counts + the most recent
// matched line. Includes every scanned container (even clean ones) so the
// Errors view can double as "yes, we're watching this one and it's quiet."
function rollup() {
  const now = Date.now();
  const h1 = now - 60 * 60 * 1000;
  const h24 = now - 24 * 60 * 60 * 1000;
  const out = Array.from(STATE.entries()).map(([id, c]) => {
    const in1h = c.matches.filter(m => m.tsMs >= h1);
    const in24h = c.matches.filter(m => m.tsMs >= h24);
    const last = c.matches.length ? c.matches[c.matches.length - 1] : null;
    return {
      id,
      name: c.name,
      slug: c.slug,
      kind: c.kind,
      scope: c.scope,
      running: c.running,
      count1h: in1h.length,
      count24h: in24h.length,
      crit24h: in24h.filter(m => m.level === 'crit').length,
      error24h: in24h.filter(m => m.level === 'error').length,
      warn24h: in24h.filter(m => m.level === 'warn').length,
      lastAt: last ? last.tsMs : null,
      lastLevel: last ? last.level : null,
      lastLine: last ? last.line : null,
      // Still open per errorscan's own bookkeeping (claimAlert has seen the
      // threshold cross but not yet a clean sweep) — independent of whether
      // the Slack post for it (or its eventual all-clear) actually landed.
      activeAlert: ACTIVE_ALERTS.has(c.name),
    };
  });
  return {
    lastSweep,
    containers: out,
    activeAlerts: [...ACTIVE_ALERTS].sort(),
    // Most recent first — a failed Slack post (alert or all-clear) with no
    // other trace anywhere. See recordPostFailure.
    postFailures: POST_FAILURES.slice(-20).reverse(),
  };
}

// Full matched-line detail for one container, most recent first.
function lines(id, limit) {
  const c = STATE.get(id);
  if (!c) return null;
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 200, 3000));
  return { ok: true, name: c.name, slug: c.slug, lines: c.matches.slice(-n).reverse() };
}

function resetForTest() {
  STATE = new Map();
  lastSweep = 0;
  ALERT_COOLDOWNS = new Map();
  alertCooldownRoot = null;
  ACTIVE_ALERTS = new Set();
  alertStateRoot = null;
  sweepInFlight = null;
  CORRELATED_INCIDENTS = new Map();
  correlatedRoot = null;
  POST_FAILURES = [];
  postFailuresRoot = null;
}

module.exports = {
  start,
  rollup,
  lines,
  _scanOne: scanOne,
  _classify: classify,
  _parseLine: parseLine,
  _alertDecision: alertDecision,
  _claimAlert: claimAlert,
  _sweep: sweep,
  _resetForTest: resetForTest,
  _alertSignature: alertSignature,
  _noteCorrelation: noteCorrelation,
  _resolveCorrelation: resolveCorrelation,
  _pruneStaleCorrelations: pruneStaleCorrelations,
  _recordPostFailure: recordPostFailure,
};
