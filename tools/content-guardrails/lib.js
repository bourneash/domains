'use strict';

// Core logic for the fleet's identity/content guardrail check. Shared by the
// git pre-commit hook (check.js CLI) and the Fleet Dashboard's guardrails
// module — keep all matching/classification logic HERE, not duplicated in
// either caller.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'logs', 'hits.jsonl');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.global = cfg.global || { blocked: [], warn: [] };
  cfg.overrides = cfg.overrides || {};
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// Effective lists for a repo = global + that repo's additive override.
// Dedup case-insensitively; overrides can only ADD terms (there's no removal
// mechanism here on purpose — deleting a global term is a config-file edit
// on this file directly, a deliberate act, not a per-repo escape hatch).
function effectiveLists(cfg, repoSlug) {
  const ov = (repoSlug && cfg.overrides[repoSlug]) || {};
  const dedup = arrs => {
    const seen = new Map(); // lowercase -> original casing (first wins)
    for (const arr of arrs) {
      for (const term of arr || []) {
        const key = term.toLowerCase().trim();
        if (key && !seen.has(key)) seen.set(key, term.trim());
      }
    }
    return [...seen.values()];
  };
  return {
    blocked: dedup([cfg.global.blocked, ov.blocked]),
    warn: dedup([cfg.global.warn, ov.warn]),
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary, case-insensitive match. Returns [{term, index}] per line.
function findMatches(text, terms) {
  const hits = [];
  const lines = text.split('\n');
  for (const term of terms) {
    const re = new RegExp(`\\b${escapeRe(term)}\\b`, 'i');
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push({ term, lineNo: i + 1, line: line.slice(0, 400) });
    });
  }
  return hits;
}

// Only the ADDED lines of a staged diff are content that could newly
// introduce a leak — scanning the whole file would flag pre-existing,
// already-committed text on every future commit to that file.
function addedLinesFromDiff(diffText) {
  return diffText
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1))
    .join('\n');
}

function sh(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

// Warn-list classification: shells out to the `claude` CLI already present
// (and already authenticated — same OAuth session every AI role uses) in
// every worker container, rather than plumbing a separate ANTHROPIC_API_KEY
// nobody has configured (see project_fleet_outage_2026-08_oauth_expiry).
// FAILS CLOSED: if the classifier can't run or gives an unparseable answer,
// treat it as a hit — a guardrail that silently opens on its own failure
// mode is worse than no guardrail.
async function classifyWarnHit(term, contextLine) {
  const prompt = [
    `A commit to a commercial affiliate/content website contains the word "${term}" in this line:`,
    '---',
    contextLine.slice(0, 500),
    '---',
    `"${term}" is a fragment of a real private individual's identity (e.g. a first name) who ` +
      'owns/operates this site portfolio and must never be named, credited, or made identifiable ' +
      'in published site content (bylines, "about us", founder/staff/contact text, author credit, ' +
      'testimonials, etc.) — that individual is never the author, founder, or point of contact ' +
      'of ANY site in this portfolio, regardless of what the draft content claims.',
    'Default to FLAG. Only answer SAFE if the match is unambiguously about someone/something ' +
      'else with no reasonable connection to site authorship/ownership — e.g. a named historical ' +
      'or public figure distinguishable by a full name or title (like "Jesse Owens"), a fictional ' +
      'character, an unrelated news subject, or the term appears only as part of an unrelated word.',
    "Any generic, unattributed, or vague reference presenting this as the site's founder, owner, " +
      'author, staff member, or contact — even with no surname given — is FLAG, not SAFE: a vague ' +
      'reference to "our founder Jesse" is exactly the pattern this guardrail exists to catch.',
    'Answer with exactly one word on the first line: FLAG or SAFE.',
    'Then a one-sentence reason on the second line.',
  ].join('\n');

  const r = await sh('claude', ['-p', '--output-format', 'text', prompt], { timeout: 45000 });
  const out = (r.stdout || '').trim();
  const firstWord = out.split(/\s+/)[0]?.toUpperCase();
  if (r.err || !firstWord) {
    return {
      flagged: true,
      reason: 'classifier unavailable — failing closed',
      raw: r.stderr || out,
    };
  }
  if (firstWord === 'SAFE') return { flagged: false, reason: out.split('\n')[1] || '', raw: out };
  // Anything other than a clean SAFE (including FLAG, or garbage) fails closed.
  return {
    flagged: true,
    reason: out.split('\n')[1] || 'classifier did not return SAFE',
    raw: out,
  };
}

function appendLog(record) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + '\n');
  } catch {
    /* logging must never break the check */
  }
}

function readLog(limit = 200) {
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Fleet-infra alert -> #domain-ops (not a per-site channel; a guardrail hit
// is an infra/compliance event, same convention as data-hub-images' monitor).
// Silently no-ops without SLACK_BOT_TOKEN, never throws.
async function postSlackAlert(repoRoot, text) {
  // Candidates, in order: this file's own domains root (host, always correct
  // since __dirname is tools/content-guardrails regardless of caller);
  // repoRoot/.env (host, repo IS the domains root); repoRoot/.env.shared
  // (container — every site mounts the domains .env there under that name);
  // repoRoot/../../.env (host, repo is a sites/<slug> submodule).
  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(repoRoot, '.env'),
    path.join(repoRoot, '.env.shared'),
    path.join(repoRoot, '..', '..', '.env'),
  ];
  let envText = '';
  for (const candidate of candidates) {
    try {
      envText = fs.readFileSync(candidate, 'utf8');
      if (envText) break;
    } catch {
      /* try next */
    }
  }
  if (!envText) return;
  const m = envText.match(/^\s*SLACK_BOT_TOKEN\s*=\s*["']?([^\s"'#]+)/m);
  const token = m && m[1];
  if (!token) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'domain-ops', attachments: [{ color: 'danger', text }] }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    /* swallow — a broken alert must never break the guardrail check */
  }
}

module.exports = {
  CONFIG_PATH,
  LOG_PATH,
  loadConfig,
  saveConfig,
  effectiveLists,
  findMatches,
  addedLinesFromDiff,
  classifyWarnHit,
  appendLog,
  readLog,
  sh,
  postSlackAlert,
};
