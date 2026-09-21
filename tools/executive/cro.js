'use strict';

const fs = require('node:fs');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');

const GITHUB_API = 'https://api.github.com';
const WINDOWS = { daily: 1, weekly: 7, monthly: 30 };
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const PURPOSES = {
  conversion: 'conversion-rate OR ab-testing OR feature-flags OR funnel OR experimentation OR cro',
  seo_content: 'seo OR sitemap OR schema OR cms OR publishing OR markdown',
  platform_ux: 'astro OR cloudflare OR worker OR edge OR accessibility OR tailwind',
  measurement: 'analytics OR attribution OR telemetry OR affiliate OR ecommerce OR tracking',
};
const PURPOSE_MATCHERS = {
  conversion:
    /conversion.?rate|ab.?test|experiment|feature.?flag|funnel|\bcro\b|growth.?experiment/i,
  seo_content:
    /seo|sitemap|structured.?data|schema\.org|cms|headless|publishing|editorial|markdown/i,
  platform_ux:
    /astro|cloudflare|worker|edge.?runtime|accessibility|accessible web|a11y|tailwind|vite|frontend/i,
  measurement: /analytic|attribution|telemetry|affiliate|ecommerce|event.?tracking|product.?feed/i,
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function searchUrl(period, now = new Date(), purpose = 'all') {
  const since = new Date(now.getTime() - WINDOWS[period] * 86400000);
  const purposeQuery = purpose === 'all' ? '' : ` (${PURPOSES[purpose] || PURPOSES.measurement})`;
  const query = `stars:>=20 pushed:>=${isoDate(since)} fork:false in:name,description${purposeQuery}`;
  return `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`;
}

async function githubJson(url, fetchImpl = globalThis.fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com')
    throw new Error('CRO GitHub request must target api.github.com over HTTPS');
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'domains-cro-research/1.0',
    'x-github-api-version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
        throw new Error('GitHub API response exceeds the CRO size limit');
      return JSON.parse(text);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function collect(now = new Date(), fetchImpl = globalThis.fetch) {
  const periods = { daily: [], weekly: [], monthly: [] };
  const errors = {};
  for (const purpose of Object.keys(PURPOSES)) {
    try {
      const payload = await githubJson(searchUrl('monthly', now, purpose), fetchImpl);
      for (const repo of (payload.items || []).slice(0, 10)) {
        const normalized = {
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
          license_spdx_id: repo.license?.spdx_id || null,
          archived: repo.archived === true,
          purpose,
        };
        const ageDays = Math.max(0, (now.getTime() - Date.parse(repo.pushed_at || now)) / 86400000);
        if (ageDays <= WINDOWS.daily) periods.daily.push(normalized);
        if (ageDays <= WINDOWS.weekly) periods.weekly.push(normalized);
        if (ageDays <= WINDOWS.monthly) periods.monthly.push(normalized);
      }
    } catch (error) {
      errors[purpose] = error.message;
    }
  }
  return { generated_at: now.toISOString(), periods, errors };
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

function purposeLabel(purpose) {
  return (
    {
      conversion: 'conversion and experimentation',
      seo_content: 'SEO and content discovery',
      platform_ux: 'Astro/Cloudflare UX and platform capability',
      measurement: 'analytics, attribution, and affiliate measurement',
    }[purpose] || 'fleet capability'
  );
}

function fitScore(repo) {
  const text =
    `${repo.full_name} ${repo.description} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const purposeMatch = PURPOSE_MATCHERS[repo.purpose]?.test(text) === true;
  return (
    (purposeMatch ? 100 : 0) +
    Math.min(30, Math.log10(Math.max(1, repo.stargazers_count || 0)) * 10) +
    (repo.archived ? -50 : 0)
  );
}

function candidates(snapshot) {
  const seen = new Set();
  return Object.entries(snapshot.periods)
    .flatMap(([period, repos]) => repos.map(repo => ({ period, ...repo })))
    .filter(repo => !seen.has(repo.full_name) && seen.add(repo.full_name))
    .map(repo => ({ ...repo, fit_score: fitScore(repo) }))
    .filter(repo => !repo.archived && repo.fit_score >= 100)
    .sort((a, b) => b.fit_score - a.fit_score || b.stargazers_count - a.stargazers_count);
}

function formatCandidate(repo) {
  const topics = repo.topics.length ? `; topics: ${repo.topics.slice(0, 5).join(', ')}` : '';
  return `- ${repo.full_name} (${purposeLabel(repo.purpose)}; ${repo.period}; ${repo.stargazers_count} stars; ${repo.language || 'mixed'}): ${repo.description || 'no description'} — ${repo.html_url}${topics}\n  Intended fleet use: ${strategy(repo)}\n  License: ${repo.license_spdx_id || 'not reported'}; fit score: ${repo.fit_score}`;
}

function buildCandidateProposal(repo, snapshot) {
  const date = snapshot.generated_at.slice(0, 10);
  return {
    title: `CRO purpose opportunity ${date}: ${repo.full_name} for ${purposeLabel(repo.purpose)}`,
    proposal_type: 'product',
    created_by: 'researcher',
    summary: `Evaluate ${repo.full_name} specifically for ${purposeLabel(repo.purpose)} across the managed fleet. This is a research lead, not an adoption recommendation.`,
    rationale: `${formatCandidate(repo)}\n\nThe CRO found this candidate through purpose-scoped GitHub searches. No repository was cloned or executed.`,
    expected_upside: {
      metric: `validated ${purposeLabel(repo.purpose)} opportunity`,
      estimate:
        'Determine whether an isolated prototype could improve a measurable fleet outcome; no revenue is assumed.',
      source: 'GitHub public repository search API and purpose-scoped fit signals',
      measurement_window: `${date} snapshot; ${repo.period} activity window`,
    },
    risks: [
      'Purpose fit is inferred from public metadata and requires CTO validation against the actual fleet stack.',
      `License is ${repo.license_spdx_id || 'not reported'} and must be verified before any use.`,
      'Third-party code must not be installed or deployed without CTO security, maintenance, and measurement review plus an owner-approved implementation proposal.',
    ],
    requested_action: `CEO and CTO: decide whether to commission bounded follow-up research for this ${purposeLabel(repo.purpose)} candidate. Do not install, clone, or deploy it.`,
  };
}

function buildProposal(snapshot) {
  const list = candidates(snapshot).slice(0, 3);
  return buildCandidateProposal(
    list[0] || {
      full_name: 'no candidate',
      purpose: 'measurement',
      period: 'none',
      stargazers_count: 0,
      topics: [],
      description: 'No purpose-fit candidate was found',
      html_url: 'https://github.com',
      language: null,
      license_spdx_id: null,
      fit_score: 0,
    },
    snapshot
  );
}

async function run({ root, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const date = isoDate(now);
  const store = eventstore.open(root);
  const titlePrefix = `CRO purpose opportunity ${date}:`;
  const existing = store
    .listExecutiveProposals({ limit: 500 })
    .filter(item => item.title.startsWith(titlePrefix));
  if (existing.length) {
    store.close();
    return { proposals: existing, proposal: existing[0], duplicate: true };
  }
  const audit = executive.action(store, {
    actor: 'researcher',
    action_type: 'research',
    summary: `CRO GitHub trend research for ${date}`,
  });
  let snapshot;
  try {
    snapshot = await collect(now, fetchImpl);
  } catch (error) {
    executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
    store.close();
    throw error;
  }
  const dataDir = path.join(root, 'tools', 'executive', 'data', 'cro');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, `${date}.json`), JSON.stringify(snapshot, null, 2), {
    mode: 0o600,
  });
  try {
    const selected = candidates(snapshot).slice(0, 3);
    const proposals = selected.map(repo =>
      executive.proposal(store, buildCandidateProposal(repo, snapshot))
    );
    const message = executive.message(store, {
      actor: 'researcher',
      body: `Daily CRO purpose-scoped GitHub research is ready for CEO/CTO review: ${proposals.length} candidate proposals were created. Each proposal has a specific fleet use, fit evidence, and safety gates.`,
      metadata: {
        proposal_ids: proposals.map(proposal => proposal.proposal_id),
        source: 'github-public-api',
        generated_at: snapshot.generated_at,
      },
    });
    executive.finishAction(store, audit.action_id, {
      status: 'completed',
      result: {
        proposal_ids: proposals.map(proposal => proposal.proposal_id),
        candidates: selected.map(repo => repo.full_name),
        periods: Object.fromEntries(
          Object.entries(snapshot.periods).map(([key, value]) => [key, value.length])
        ),
        errors: snapshot.errors,
      },
    });
    return { snapshot, proposals, proposal: proposals[0] || null, message, duplicate: false };
  } catch (error) {
    executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
    throw error;
  } finally {
    store.close();
  }
}

function recent(root, limit = 7) {
  const dir = path.join(root, 'tools', 'executive', 'data', 'cro');
  try {
    return fs
      .readdirSync(dir)
      .filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .sort()
      .reverse()
      .slice(0, limit)
      .map(file => {
        const snapshot = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return {
          date: file.slice(0, 10),
          generated_at: snapshot.generated_at,
          periods: Object.fromEntries(
            Object.entries(snapshot.periods || {}).map(([key, value]) => [key, value.length])
          ),
          errors: snapshot.errors || {},
          candidates: candidates(snapshot)
            .slice(0, 12)
            .map(repo => ({
              full_name: repo.full_name,
              html_url: repo.html_url,
              period: repo.period,
              stars: repo.stargazers_count,
              language: repo.language,
              description: repo.description,
              purpose: repo.purpose,
              fit_score: repo.fit_score,
              license_spdx_id: repo.license_spdx_id,
            })),
        };
      });
  } catch {
    return [];
  }
}

if (require.main === module) {
  const root = process.env.FLEET_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
  run({ root })
    .then(result =>
      process.stdout.write(
        `${JSON.stringify({ proposal_ids: (result.proposals || []).map(item => item.proposal_id), duplicate: result.duplicate })}\n`
      )
    )
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { WINDOWS, searchUrl, collect, candidates, strategy, buildProposal, recent, run };
