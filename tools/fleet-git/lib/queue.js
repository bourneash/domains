'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Overridable so tests never touch the LIVE queue. Without this they read,
// rewrite and restore the real state/queue.json — which races the hourly cron
// sweep writing the same file, and can drop real review items.
const STATE_DIR = process.env.FLEET_GIT_STATE_DIR || path.join(__dirname, '..', 'state');
const QUEUE_PATH = path.join(STATE_DIR, 'queue.json');
const LAST_PATH = path.join(STATE_DIR, 'last-sweep.json');

// A parse failure is NOT the same as "no file". Silently returning an empty
// queue on a half-written read, then persisting that, deletes every open review
// item and every `first_seen` — so the >24h nag can never fire again. Missing
// file → fallback; corrupt file → preserve it and throw.
function readJson(p, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const bak = `${p}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(p, bak);
    } catch {
      /* best effort */
    }
    throw new Error(`${p} is not valid JSON (copy kept at ${bak}): ${e.message}`);
  }
}

// Write beside the target and rename — atomic within a filesystem, so a reader
// never sees a partial file. The cron sweep and the dashboard both write here.
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

const key = (slug, p) => `${slug}:${p}`;

function load() {
  const q = readJson(QUEUE_PATH, { version: 1, items: {} });
  q.items = q.items || {};
  return q;
}

// Merge this sweep's review items into the persistent queue. Items keep their
// first_seen (so "this has been unresolved for 6 days" is answerable) and are
// auto-closed when they stop appearing — a path an operator fixed by hand
// disappears from the board without anyone clicking anything.
function reconcile(reviewsBySlug, { now, sweptSlugs }) {
  const q = load();
  const seen = new Set();
  for (const [slug, reviews] of Object.entries(reviewsBySlug)) {
    for (const r of reviews) {
      const k = key(slug, r.path);
      seen.add(k);
      const prev = q.items[k];
      q.items[k] = {
        slug,
        path: r.path,
        kind: r.kind,
        reason: r.reason,
        first_seen: prev?.first_seen || now,
        last_seen: now,
        status: 'open',
      };
    }
  }
  for (const [k, item] of Object.entries(q.items)) {
    if (seen.has(k)) continue;
    // Only auto-close items belonging to a repo this sweep actually visited.
    if (!sweptSlugs.has(item.slug)) continue;
    delete q.items[k];
  }
  writeJson(QUEUE_PATH, q);
  return q;
}

function open() {
  return Object.values(load().items).filter(i => i.status === 'open');
}

function remove(slug, p) {
  const q = load();
  delete q.items[key(slug, p)];
  writeJson(QUEUE_PATH, q);
}

function saveSweep(report) {
  writeJson(LAST_PATH, report);
}

function lastSweep() {
  return readJson(LAST_PATH, null);
}

module.exports = {
  load,
  reconcile,
  open,
  remove,
  saveSweep,
  lastSweep,
  QUEUE_PATH,
  LAST_PATH,
  STATE_DIR,
};
