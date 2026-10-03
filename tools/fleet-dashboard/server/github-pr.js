'use strict';

// The review branch is not a pull request until GitHub confirms one exists.
// Keep the token server-side and make retries idempotent after a branch push.
const fs = require('node:fs');
const path = require('node:path');

function tokenFor(root, env = process.env) {
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return env.GITHUB_TOKEN || env.GH_TOKEN;
  const source = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const match = source.match(/^GITHUB_TOKEN\s*=\s*(.+)\s*$/m);
  if (!match) throw new Error('GITHUB_TOKEN is unavailable for pull-request publishing');
  return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

function repoFromWebUrl(webUrl) {
  const match = String(webUrl || '').match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/);
  if (!match) throw new Error('pull-request publishing requires a GitHub repository remote');
  return `${match[1]}/${match[2]}`;
}

async function github(root, repo, endpoint, { method = 'GET', body, fetchImpl = fetch, env } = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokenFor(root, env)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'domains-review-delivery',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`GitHub PR API HTTP ${response.status}: ${data?.message || 'request failed'}`);
  return data;
}

function summary(row) {
  return {
    number: row.number,
    url: row.html_url,
    state: row.state,
    merged_at: row.merged_at || null,
    head_sha: row.head?.sha || null,
    base_sha: row.base?.sha || null,
  };
}

async function ensure(root, webUrl, branch, title, body, options = {}) {
  if (!/^improvement\/[a-f0-9]+$/.test(String(branch || '')))
    throw new Error('unexpected improvement branch');
  const repo = repoFromWebUrl(webUrl);
  const owner = repo.split('/')[0];
  const query = new URLSearchParams({
    state: 'open',
    head: `${owner}:${branch}`,
    base: 'main',
    per_page: '100',
  });
  const existing = await github(root, repo, `/pulls?${query}`, options);
  if (existing.length) return summary(existing[0]);
  const created = await github(root, repo, '/pulls', {
    ...options,
    method: 'POST',
    body: { title, head: branch, base: 'main', body, draft: false },
  });
  return summary(created);
}

module.exports = { ensure, github, repoFromWebUrl, summary };
