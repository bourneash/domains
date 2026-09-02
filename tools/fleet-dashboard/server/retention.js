'use strict';

// Retention policy — read and edit tools/retention/policy.yaml from the panel.
//
// Retention used to be one --retain-days flag plus an env var, so "how long do
// we keep X" had no per-class answer and no answer anyone could see without
// opening the prune script. The policy file is the config surface; this module
// is how the fleet manager reads and changes it.
//
// THE RULE THE POLICY ENCODES, and the reason this module refuses some edits:
// on this host retention means COMPRESS, not DELETE. cf-stats is the only
// historical record of Cloudflare traffic anywhere and nothing backs it up; the
// role logs are the audit trail for autonomous publishing runs. Both compress
// 10-15x, so compression reclaims essentially all of the space while keeping
// every byte recoverable. Turning on deletion is therefore a deliberate act
// that this API will not perform — `delete_after_days` is read-only here and
// has to be set by editing the file, which forces a human to read the rule
// above first. Only retain_days is editable through the panel.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Guard rails on what the panel may set. Below the floor a sweep would archive
// data still being actively written; above the ceiling it is not retention.
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

function policyPath(root) {
  return path.join(root, 'tools', 'retention', 'policy.yaml');
}

function read(root) {
  const p = policyPath(root);
  if (!fs.existsSync(p)) {
    return { ok: false, error: 'tools/retention/policy.yaml not found', classes: [] };
  }
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {
    return { ok: false, error: `unparseable policy: ${e.message}`, classes: [] };
  }
  const defaults = doc.defaults || {};
  const classes = Object.entries(doc.classes || {}).map(([name, c]) => ({
    name,
    label: c.label || name,
    paths: c.paths || [],
    method: c.method || null,
    retain_days: typeof c.retain_days === 'number' ? c.retain_days : (defaults.retain_days ?? null),
    // Surfaced so the panel can show "never deleted" honestly, but not settable
    // from here — see the module header.
    delete_after_days: c.delete_after_days ?? null,
    why: c.why || null,
    never_touch: c.never_touch || [],
  }));
  return {
    ok: true,
    path: p,
    version: doc.version ?? null,
    defaults: { retain_days: defaults.retain_days ?? 30, delete_after_days: defaults.delete_after_days ?? null },
    classes,
    editable: ['retain_days'],
  };
}

// Set retain_days for one class (or the defaults block). Rewrites only that
// scalar and leaves the file's comments and structure alone — the comments in
// that file carry the reasoning for every number in it, and a naive
// yaml.dump() round-trip would silently delete all of them.
function setRetainDays(root, { klass, days }) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) {
    return { ok: false, error: `retain_days must be an integer between ${MIN_DAYS} and ${MAX_DAYS}` };
  }
  const p = policyPath(root);
  if (!fs.existsSync(p)) return { ok: false, error: 'policy file not found' };

  const cur = read(root);
  if (!cur.ok) return cur;
  const isDefaults = klass === 'defaults';
  if (!isDefaults && !cur.classes.some((c) => c.name === klass)) {
    return { ok: false, error: `unknown class: ${klass}` };
  }

  const lines = fs.readFileSync(p, 'utf8').split('\n');
  // Walk to the target block, then rewrite the first retain_days inside it.
  let inTarget = isDefaults;
  let depthMarker = isDefaults ? 'defaults:' : null;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^defaults:/.test(line)) inTarget = isDefaults;
    else if (/^classes:/.test(line)) inTarget = false;
    else if (/^ {2}\S.*:\s*$/.test(line) && !isDefaults) {
      inTarget = line.trim().replace(/:$/, '') === klass;
      depthMarker = klass;
    } else if (/^\S/.test(line)) {
      inTarget = false;
    }
    if (inTarget && /^\s*retain_days:\s*\d+\s*$/.test(line)) {
      const indent = line.match(/^\s*/)[0];
      lines[i] = `${indent}retain_days: ${n}`;
      done = true;
      break;
    }
  }
  if (!done) return { ok: false, error: `no retain_days line found for ${klass}` };

  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  // Parse the result before it replaces the real file: a policy this API
  // corrupted would silently change what the nightly sweep archives.
  try {
    yaml.load(fs.readFileSync(tmp, 'utf8'));
  } catch (e) {
    fs.unlinkSync(tmp);
    return { ok: false, error: `refused: edit would corrupt the policy (${e.message})` };
  }
  fs.renameSync(tmp, p);
  return { ok: true, klass, retain_days: n, ...read(root) };
}

module.exports = { read, setRetainDays, MIN_DAYS, MAX_DAYS };
