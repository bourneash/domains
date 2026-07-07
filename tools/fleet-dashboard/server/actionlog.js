'use strict';

// Persisted, append-only audit trail for mutating actions (B4).
//
// The fleet control plane pushes commits and force-recreates containers across
// the whole portfolio; without a durable record, "something restarted every
// cron at 3am" is unanswerable. This module appends one JSON line per mutating
// API request to data/actions.jsonl, and exposes a bounded tail for the
// /api/actions endpoint.
//
// Design notes:
//   • Append-only JSONL — cheap, greppable, survives container recreation as
//     long as the tool dir is bind-mounted (it is, via docker-compose).
//   • Actor is a stable, NON-secret fingerprint of the caller's token/cookie
//     (first 8 hex of a SHA-256), never the token itself, plus the source IP.
//   • Request bodies are recorded but sanitized — any `token`/`password` field
//     is redacted, and /api/login is never logged with a body.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOG_DIR = process.env.FD_DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'actions.jsonl');
const MAX_BODY_CHARS = 4000;      // cap oversized bodies so one request can't bloat the log line

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* best effort */ }
}

// Stable, non-reversible fingerprint of whatever credential the caller presented
// (token header or auth cookie). Lets you correlate actions to a caller without
// ever storing the secret. Returns 'anon' when no credential is present.
function actorFingerprint(req) {
  const cred = req.headers['x-fd-token']
    || (req.headers.cookie && /(?:^|;\s*)fd_auth=([^;]+)/.exec(req.headers.cookie)?.[1])
    || '';
  if (!cred) return 'anon';
  return 'tok:' + crypto.createHash('sha256').update(String(cred)).digest('hex').slice(0, 8);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || null;
}

// Deep-copy a body with secrets redacted and size capped. Never throws.
function sanitizeBody(body) {
  if (body == null || typeof body !== 'object') return undefined;
  let json;
  try {
    json = JSON.stringify(body, (k, v) =>
      /token|password|secret/i.test(k) ? '[redacted]' : v);
  } catch { return undefined; }
  if (json === undefined || json === '{}' || json === '[]') return undefined;
  return json.length > MAX_BODY_CHARS ? json.slice(0, MAX_BODY_CHARS) + '…[truncated]' : json;
}

// Append one record. Best-effort: a logging failure must never break the action
// it is recording, so all fs errors are swallowed.
function record(entry) {
  ensureDir();
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* disk full / read-only mount — degrade silently */ }
}

// Express middleware: log every completed mutating /api/* request (POST/PUT/
// DELETE/PATCH). Attaches on `finish` so it captures the final status code and
// duration, including auth denials (401/403) — a rejected mutation attempt is
// itself worth recording. Read requests (GET/HEAD) are never logged.
function middleware(req, res, next) {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!write || !req.path.startsWith('/api/')) return next();
  const start = Date.now();
  // Snapshot the body now — a handler may mutate req.body before `finish` fires.
  const body = req.path === '/api/login' ? undefined : sanitizeBody(req.body);
  res.on('finish', () => {
    record({
      ts: new Date().toISOString(),
      actor: actorFingerprint(req),
      ip: clientIp(req),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ok: res.statusCode < 400,
      ms: Date.now() - start,
      body,
    });
  });
  next();
}

// Bounded tail of the most-recent N records (newest first) for /api/actions.
function tail(n = 200) {
  const limit = Math.max(1, Math.min(parseInt(n, 10) || 200, 2000));
  let text = '';
  try { text = fs.readFileSync(LOG_FILE, 'utf8'); } catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { out.push(JSON.parse(lines[i])); } catch { /* skip a corrupt line */ }
  }
  return out;
}

module.exports = { middleware, record, tail, LOG_FILE, _actorFingerprint: actorFingerprint, _sanitizeBody: sanitizeBody };
