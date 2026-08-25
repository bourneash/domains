'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('./glob');

const POLICY_PATH = path.join(__dirname, '..', 'policy.json');

const ACTIONS = new Set(['block', 'ignore', 'commit', 'review']);

function load(policyPath = POLICY_PATH) {
  const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  return compilePolicy(raw);
}

// Compile once, match many. `block` rules are hoisted so a credential can
// never be shadowed by an earlier convenience rule someone appended later.
function compilePolicy(raw) {
  const rules = (raw.rules || []).map((r, i) => {
    if (!ACTIONS.has(r.action)) throw new Error(`policy rule ${r.id || i}: bad action ${r.action}`);
    if (!Array.isArray(r.match) || !r.match.length)
      throw new Error(`policy rule ${r.id || i}: empty match`);
    return {
      ...r,
      order: i,
      _match: compile(r.match),
      _except: compile(r.except || []),
      _scope: r.scope === 'fleet' ? 'fleet' : new Set(Array.isArray(r.scope) ? r.scope : [r.scope]),
    };
  });
  const blocks = rules.filter(r => r.action === 'block');
  const rest = rules.filter(r => r.action !== 'block');
  return {
    raw,
    version: raw.version,
    limits: { max_files_per_commit: 200, max_file_bytes: 5 * 1024 * 1024, ...(raw.limits || {}) },
    ignoreBlock: raw.ignore_block || [],
    rules: [...blocks, ...rest],
  };
}

function inScope(rule, slug) {
  return rule._scope === 'fleet' || rule._scope.has(slug);
}

// First matching in-scope rule wins; unmatched → review (never silently
// committed, never silently ignored).
function ruleFor(policy, slug, filePath) {
  const { matchesAny } = require('./glob');
  for (const r of policy.rules) {
    if (!inScope(r, slug)) continue;
    if (r._except.length && matchesAny(r._except, filePath)) continue;
    if (matchesAny(r._match, filePath)) return r;
  }
  return null;
}

// Append a rule and persist. Used by the dashboard's "always ignore" /
// "always commit" buttons — the review queue drains permanently instead of
// re-asking the operator the same question every sweep.
function addRule(rule, policyPath = POLICY_PATH) {
  const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  if ((raw.rules || []).some(r => r.id === rule.id))
    throw new Error(`policy already has a rule id "${rule.id}"`);
  compilePolicy({ ...raw, rules: [...(raw.rules || []), rule] }); // validate before write
  raw.rules = [...(raw.rules || []), rule];
  fs.writeFileSync(policyPath, JSON.stringify(raw, null, 2) + '\n');
  return rule;
}

// Which of a rule's globs actually matched. Used when a path has to be written
// into a .gitignore: the PATTERN generalises (`**/__pycache__/`), the literal
// path does not — appending `ops/scripts/__pycache__/x.cpython-311.pyc` would
// grow one line per file forever.
function matchedPattern(rule, filePath) {
  const { matchesAny } = require('./glob');
  for (let i = 0; i < rule._match.length; i++) {
    if (matchesAny([rule._match[i]], filePath)) return rule.match[i];
  }
  return null;
}

module.exports = { load, compilePolicy, ruleFor, inScope, addRule, matchedPattern, POLICY_PATH };
