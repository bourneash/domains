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
let sweepInFlight = null;

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
// notify must never break the sweep).
async function postSlackAlert(root, slug, text) {
  const envText = loadEnvText(root);
  const token = envVar(envText, 'SLACK_BOT_TOKEN');
  if (!token) return;
  const channel = channelForSlug(envText, slug);
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, attachments: [{ color: 'danger', text }] }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    /* swallow — see comment above */
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
  const key = c.name || `${c.slug || 'unknown'}:${c.kind || 'container'}`;
  const prevAlertAt = ALERT_COOLDOWNS.get(key) || null;
  const decision = alertDecision(c, recent1h, prevAlertAt, now);
  if (decision.shouldAlert) {
    ALERT_COOLDOWNS.set(key, now);
    persistAlertCooldowns(root);
  }
  return { ...decision, lastAlertAt: decision.shouldAlert ? now : prevAlertAt };
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
    const text =
      `:rotating_light: *${c.name}* — ${decision.label} (${decision.errorish1h} error/crit line(s) in the last hour)\n` +
      `Trigger: \`${((decision.trigger && decision.trigger.line) || '').slice(0, 300)}\`\n` +
      'Fleet Dashboard → Errors tab for detail.';
    postSlackAlert(root, c.slug, text).catch(() => {});
  }
}

async function sweep(root) {
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
    };
  });
  return { lastSweep, containers: out };
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
  sweepInFlight = null;
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
};
