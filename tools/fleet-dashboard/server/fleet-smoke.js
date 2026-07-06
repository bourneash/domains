'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const gitDefault = require('./git');

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

function smokeYamlPath(root, slug) {
  return path.join(root, 'sites', slug, 'ops', 'smoke.yaml');
}

function statePath(root, slug) {
  return path.join(root, 'tools', 'fleet-smoke', 'state', `${slug}.json`);
}

// Returns null if unconfigured, {error} if present-but-unparseable, else the parsed object.
function readConfig(root, slug) {
  const p = smokeYamlPath(root, slug);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return { data: yaml.load(raw) || {} };
  } catch (e) {
    return { error: `invalid YAML in ${slug}/ops/smoke.yaml: ${e.message}` };
  }
}

function readState(root, slug) {
  const p = statePath(root, slug);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// One row for a single site. `configured` mirrors readConfig's three outcomes:
// no file → configured:false; unparseable → configured:true + error; else the
// full row with toggles + status.
function rowFor(root, slug) {
  const cfg = readConfig(root, slug);
  if (cfg === null) return { slug, configured: false, status: null };
  if (cfg.error) return { slug, configured: true, error: cfg.error, status: null };

  const data = cfg.data;
  const enabled = data.enabled !== false;
  const slackEnabled = !data.slack || data.slack.enabled !== false;
  const checksCount = Array.isArray(data.checks) ? data.checks.length : 0;

  const state = readState(root, slug);
  let status = null;
  if (state && typeof state.fail === 'number' && typeof state.headline_word === 'string') {
    status = { icon: state.headline_word, pass: checksCount - state.fail, total: checksCount };
  }

  return { slug, configured: true, enabled, slackEnabled, checksCount, status };
}

function listSites(root, slugs) {
  return slugs.map((slug) => rowFor(root, slug));
}

// field is exactly "enabled" or "slack.enabled" — the only two levers this
// panel exposes. Anything else is a caller bug, not a user-facing 400 (the
// route layer only ever calls this with one of the two literals).
function applyField(data, field, value) {
  if (field === 'enabled') { data.enabled = value; return; }
  if (field === 'slack.enabled') {
    data.slack = data.slack || {};
    data.slack.enabled = value;
    return;
  }
  throw httpErr(400, `unknown field: ${field}`);
}

async function toggleField(root, slug, field, value, deps = {}) {
  const git = deps.git || gitDefault;
  const p = smokeYamlPath(root, slug);
  if (!fs.existsSync(p)) throw httpErr(404, `${slug} has no ops/smoke.yaml`);

  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try { data = yaml.load(raw) || {}; }
  catch (e) { throw httpErr(500, `invalid YAML in ${slug}/ops/smoke.yaml: ${e.message}`); }

  applyField(data, field, value);
  fs.writeFileSync(p, yaml.dump(data));

  await git.commit(root, slug, ['ops/smoke.yaml'], `fleet-smoke: toggle ${field} for ${slug}`);

  let pushed = true, pushError;
  try { await git.push(root, slug); }
  catch (e) { pushed = false; pushError = e.message; }

  const row = rowFor(root, slug);
  return pushed ? { ok: true, pushed, row } : { ok: true, pushed, pushError, row };
}

module.exports = { listSites, rowFor, toggleField, smokeYamlPath, statePath };
