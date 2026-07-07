'use strict';

// Access control for the fleet dashboard (F1 / addresses B2, B3).
//
// Two independent layers, both installed as Express middleware:
//
//   1. Host allowlist — ALWAYS ON. Every request's Host header must resolve to
//      an allowed hostname. This defeats DNS-rebinding (a malicious page that
//      rebinds its name to 127.0.0.1 to reach this port from a host browser),
//      because the forged request still carries the attacker's Host header.
//      Defaults cover the loopback publish and the in-compose service name;
//      extend via FD_ALLOWED_HOSTS (comma-separated), or set it to `*` to
//      disable the check entirely.
//
//   2. Token gate — ON only when FD_TOKEN is set (opt-in, so existing loopback
//      installs keep working). When set, every /api/* request (except a small
//      exempt set needed to render the login UI) must present the token via the
//      `x-fd-token` header or the httpOnly `fd_auth` cookie that POST /api/login
//      sets. Without a token, anyone who can reach the port has full control of
//      the fleet — set FD_TOKEN before exposing this beyond loopback or onto the
//      shared vpn_proxy network.

const crypto = require('node:crypto');

const TOKEN = process.env.FD_TOKEN || null;
const COOKIE = 'fd_auth';
// The cookie carries an HMAC of a constant under the token, never the token
// itself — so a leaked cookie doesn't reveal the shared secret.
const COOKIE_VAL = TOKEN ? crypto.createHmac('sha256', TOKEN).update('fd-auth-v1').digest('hex') : null;

const DEFAULT_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1', 'fleet-dashboard', 'panel'];
const ALLOWED_HOSTS = new Set(
  (process.env.FD_ALLOWED_HOSTS ? process.env.FD_ALLOWED_HOSTS.split(',') : [])
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .concat(DEFAULT_HOSTS),
);

// Paths reachable without a token so the login screen can bootstrap.
const EXEMPT = new Set(['/api/version', '/api/login', '/api/auth', '/healthz']);

function hostname(req) {
  return (req.hostname || (req.headers.host || '').split(':')[0] || '').toLowerCase();
}

function hostAllowed(req) {
  if (ALLOWED_HOSTS.has('*')) return true;
  const h = hostname(req);
  return !!h && ALLOWED_HOSTS.has(h);
}

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function tokenValid(t) {
  return !!TOKEN && safeEqual(String(t || ''), TOKEN);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authed(req) {
  if (!TOKEN) return true;                                  // token gate disabled
  if (tokenValid(req.headers['x-fd-token'])) return true;   // header (programmatic clients)
  return safeEqual(parseCookies(req)[COOKIE] || '', COOKIE_VAL);   // cookie (browser)
}

// Layer 1: host allowlist for ALL requests.
function hostGuard(req, res, next) {
  if (!hostAllowed(req)) return res.status(403).json({ error: 'host not allowed' });
  next();
}

// Layer 2: token gate. Mounted app-wide (NOT on '/api', which would strip the
// prefix and break the EXEMPT match). Only /api/* is guarded; everything else
// (static shell, /healthz) passes so the login UI can load.
function apiGuard(req, res, next) {
  if (!TOKEN) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (EXEMPT.has(req.path)) return next();
  if (authed(req)) return next();
  return res.status(401).json({ error: 'authentication required' });
}

// POST /api/login { token } — validates and sets the auth cookie.
function loginHandler(req, res) {
  if (!TOKEN) return res.json({ ok: true, authRequired: false });
  if (!tokenValid((req.body || {}).token)) return res.status(401).json({ error: 'invalid token' });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${COOKIE_VAL}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`);
  res.json({ ok: true });
}

// GET /api/auth — whether a token is required and whether this caller has it.
function authStatus(req, res) {
  res.json({ authRequired: !!TOKEN, authed: authed(req) });
}

module.exports = {
  hostGuard, apiGuard, loginHandler, authStatus, authed, hostAllowed, tokenValid,
  TOKEN, COOKIE, _parseCookies: parseCookies,
};
