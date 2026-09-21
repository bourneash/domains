'use strict';

const fs = require('node:fs');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');

const GITHUB_API = 'https://api.github.com';
const WINDOWS = { daily: 1, weekly: 7, monthly: 30 };

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function searchUrl(period, now = new Date()) {
  const since = new Date(now.getTime() - WINDOWS[period] * 86400000);
  const query = `stars:>=50 pushed:>=${isoDate(since)} fork:false`;
  return `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`;
}

async function githubJson(url, fetchImpl = globalThis.fetch) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'domains-cro-research/1.0',
    'x-github-api-version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  return response.json();
}

async function collect(now = new Date(), fetchImpl = globalThis.fetch) {
  const periods = {};
  for (const period of Object.keys(WINDOWS)) {
    const payload = await githubJson(searchUrl(period, now), fetchImpl);
    periods[period] = (payload.items || []).slice(0, 10).map(repo => ({
      full_name: repo.full_name,
      html_url: repo.html_url,
      description: repo.description || '',
      language: repo.language || null,
      topics: repo.topics || [],
      stargazers_count: repo.stargazers_count,
      forks_count: repo.forks_count,
      open_issues_count: repo.open_issues_count,
      pushed_at: repo.pushed_at,
      created_at: repo.created_at,
    }));
  }
  return { generated_at: now.toISOString(), periods };
}

function strategy(repo) {
  const text =
    `${repo.description} ${(repo.topics || []).join(' ')} ${repo.language || ''}`.toLowerCase();
  if (/security|auth|privacy|vulnerab/.test(text))
    return 'Assess as a security or trust improvement; require an isolated proof of concept and threat-model review before production use.';
  if (/analytics|search|recommend|data|database|vector|ai|llm|model/.test(text))
    return 'Assess as a data, discovery, or AI capability; define a measurable user or revenue outcome before integrating.';
  if (/astro|react|next|tailwind|web|frontend|css|javascript|typescript/.test(text))
    return 'Assess as a reusable site capability or UX experiment; prototype against one representative site and measure performance and conversion.';
  return 'Assess for a narrowly scoped internal tool or site capability; verify license, maintenance health, security, and a measurable fleet benefit first.';
}

function candidates(snapshot) {
  const seen = new Set();
  return Object.entries(snapshot.periods)
    .flatMap(([period, repos]) => repos.map(repo => ({ period, ...repo })))
    .filter(repo => !seen.has(repo.full_name) && seen.add(repo.full_name))
    .sort((a, b) => b.stargazers_count - a.stargazers_count);
}

function formatCandidate(repo) {
  const topics = repo.topics.length ? `; topics: ${repo.topics.slice(0, 5).join(', ')}` : '';
  return `- ${repo.full_name} (${repo.period}, ${repo.stargazers_count} stars, ${repo.language || 'mixed'}): ${repo.description || 'no description'} — ${repo.html_url}${topics}\n  CRO strategy: ${strategy(repo)}`;
}

function buildProposal(snapshot) {
  const list = candidates(snapshot).slice(0, 12);
  const date = snapshot.generated_at.slice(0, 10);
  return {
    title: `CRO GitHub trend digest — ${date}`,
    proposal_type: 'product',
    created_by: 'researcher',
    summary: `The CRO reviewed public GitHub repository momentum across daily, weekly, and monthly windows. ${list.length} distinct projects are surfaced for CEO/CTO review; no repository was cloned or executed.`,
    rationale: list.map(formatCandidate).join('\n'),
    expected_upside: {
      metric: 'validated integration opportunities',
      estimate: 'Identify 0–3 candidates worth an isolated prototype; no revenue is assumed.',
      source: 'GitHub public repository search API',
      measurement_window: `${date} snapshot; daily/weekly/monthly activity windows`,
    },
    risks: [
      'Stars and recent pushes are signals, not proof of quality, fit, license compatibility, security, or product value.',
      'Third-party code must not be installed or deployed without CTO review, license review, security review, and an explicit owner-approved implementation proposal.',
    ],
    requested_action:
      'CEO and CTO: select at most three candidates for bounded follow-up research. Approve a separate implementation proposal only after fit, license, security, maintenance, and measurement plans are documented.',
  };
}

async function run({ root, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const snapshot = await collect(now, fetchImpl);
  const dataDir = path.join(root, 'tools', 'executive', 'data', 'cro');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const date = isoDate(now);
  fs.writeFileSync(path.join(dataDir, `${date}.json`), JSON.stringify(snapshot, null, 2), {
    mode: 0o600,
  });
  const store = eventstore.open(root);
  try {
    const title = `CRO GitHub trend digest — ${date}`;
    const existing = store
      .listExecutiveProposals({ limit: 500 })
      .find(item => item.title === title);
    if (existing) return { snapshot, proposal: existing, duplicate: true };
    const proposal = executive.proposal(store, buildProposal(snapshot));
    const message = executive.message(store, {
      actor: 'researcher',
      body: `Daily CRO GitHub research is ready for CEO/CTO review: ${proposal.title}. The digest is in the executive proposal queue; it contains evidence, integration strategies, and safety gates.`,
      metadata: {
        proposal_id: proposal.proposal_id,
        source: 'github-public-api',
        generated_at: snapshot.generated_at,
      },
    });
    return { snapshot, proposal, message, duplicate: false };
  } finally {
    store.close();
  }
}

if (require.main === module) {
  const root = process.env.FLEET_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
  run({ root })
    .then(result =>
      process.stdout.write(
        `${JSON.stringify({ proposal_id: result.proposal.proposal_id, duplicate: result.duplicate })}\n`
      )
    )
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { WINDOWS, searchUrl, collect, candidates, strategy, buildProposal, run };
