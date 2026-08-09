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
const containers = require('./containers');

const POLL_MS = 3 * 60 * 1000;             // scan cadence
const CONCURRENCY = 4;                     // parallel `docker logs` fetches
const RETENTION_MS = 26 * 60 * 60 * 1000;  // keep matches this long (covers the 24h rollup + slack)
const MAX_LINES_PER_CONTAINER = 3000;      // hard cap so one chatty container can't blow up memory
const FIRST_SCAN_SINCE = '24h';            // backfill window the first time we see a container
const FIRST_SCAN_TAIL = '5000';            // bound the backfill cost for a chatty container's history

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
];

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

// id -> { name, slug, kind, scope, running, sinceIso, matches: [{tsMs, level, line}] }
let STATE = new Map();
let lastSweep = 0;

function classify(text) {
  if (SUPPRESS_RE.some((re) => re.test(text))) return null;
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

async function scanOne(c) {
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

  const cutoff = Date.now() - RETENTION_MS;
  const pruned = matches.filter((m) => m.tsMs >= cutoff);
  const trimmed = pruned.length > MAX_LINES_PER_CONTAINER ? pruned.slice(-MAX_LINES_PER_CONTAINER) : pruned;

  STATE.set(c.id, {
    name: c.name, slug: c.slug, kind: c.kind, scope: c.scope, running: c.running,
    sinceIso: sinceIso || new Date().toISOString(),
    matches: trimmed,
  });
}

async function sweep(root) {
  const list = await containers.list(root);
  const seen = new Set(list.map((c) => c.id));
  // Drop containers that no longer exist — a restart/rebuild gets a fresh id,
  // so its predecessor's history simply ages out rather than being carried over.
  for (const id of STATE.keys()) if (!seen.has(id)) STATE.delete(id);

  const queue = list.slice();
  async function worker() {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try { await scanOne(c); } catch { /* one bad container shouldn't kill the sweep */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  lastSweep = Date.now();
}

// Start the background timer (immediate first sweep, then every POLL_MS). The
// timer is unref'd so it never holds the process open on shutdown.
function start(root) {
  const tick = () => { sweep(root).catch(() => { /* swallow; rollup simply goes stale */ }); };
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
    const in1h = c.matches.filter((m) => m.tsMs >= h1);
    const in24h = c.matches.filter((m) => m.tsMs >= h24);
    const last = c.matches.length ? c.matches[c.matches.length - 1] : null;
    return {
      id, name: c.name, slug: c.slug, kind: c.kind, scope: c.scope, running: c.running,
      count1h: in1h.length, count24h: in24h.length,
      crit24h: in24h.filter((m) => m.level === 'crit').length,
      error24h: in24h.filter((m) => m.level === 'error').length,
      warn24h: in24h.filter((m) => m.level === 'warn').length,
      lastAt: last ? last.tsMs : null, lastLevel: last ? last.level : null, lastLine: last ? last.line : null,
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

module.exports = { start, rollup, lines, _scanOne: scanOne, _classify: classify, _parseLine: parseLine, _sweep: sweep };
