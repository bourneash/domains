'use strict';

// Read-only launch-readiness artifacts checked into the repository so
// executive runs and human reviewers use the same evidence checklist. This is
// risk triage and workflow state, not a legal opinion.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join('ops', 'executive', 'checklists');

function exists(root, relative) {
  try {
    return fs.existsSync(path.join(root, 'sites', relative));
  } catch {
    return false;
  }
}

function evidenceSummary(root, checklist) {
  const site = String(checklist?.site || '').trim();
  if (!site) return null;
  const manual = exists(root, `${site}/WootDeveloperManual/woot_api_documentation.md`);
  const terms = exists(root, `${site}/site/public/terms.html`);
  const privacy = exists(root, `${site}/site/public/privacy.html`);
  const cookiePolicy = exists(root, `${site}/site/public/cookie-policy.html`);
  const backend = exists(root, `${site}/backend/api/main.py`);
  const fetcher = exists(root, `${site}/backend/services/fetcher.py`);
  const config = exists(root, `${site}/config.yml`);
  const authoritative = checklist.authoritative_evidence || {};
  const sourceRights = {
    status: authoritative.disposition || (manual ? 'evidence_needed' : 'missing'),
    local_source: manual ? 'WootDeveloperManual/woot_api_documentation.md' : null,
    source_url: authoritative.source_url || 'https://developer.woot.com/',
    source_urls: [
      authoritative.source_url,
      ...(authoritative.sources || []).map(source => source.url),
    ].filter(Boolean),
    documented: authoritative.confirmed || (manual ? ['API documentation'] : []),
    missing: authoritative.not_confirmed || [
      manual
        ? 'current API agreement or written permission for storage, historical derivatives, public display, and alerts'
        : 'official API documentation and the API agreement or written permission',
    ],
    note: authoritative.note || null,
    next_action: authoritative.next_action || null,
  };
  return {
    generated_at: new Date().toISOString(),
    site,
    disposition: checklist.current_disposition || 'unknown',
    source_rights: sourceRights,
    data_flow: {
      status: backend && fetcher && config ? 'partial' : 'missing',
      evidence_files: [
        backend && 'backend/api/main.py',
        fetcher && 'backend/services/fetcher.py',
        config && 'config.yml',
      ].filter(Boolean),
      missing: [
        'operator-confirmed retention, deletion, correction, access, and notification records',
      ],
    },
    consent_and_analytics: {
      status: privacy && cookiePolicy ? 'partial' : 'missing',
      evidence_files: [
        privacy && 'site/public/privacy.html',
        cookiePolicy && 'site/public/cookie-policy.html',
      ].filter(Boolean),
      missing: ['GA4 property/data-sharing settings and jurisdiction-specific counsel review'],
    },
    public_terms: {
      status: terms ? 'draft_only' : 'missing',
      evidence_files: terms ? ['site/public/terms.html'] : [],
      note: 'Site terms are not evidence of permission from the upstream data provider.',
    },
    launch_blockers: [
      'authoritative Woot API rights/permission evidence',
      'human legal review of data use, privacy, and any future affiliate or advertising use',
      'security, accuracy/freshness, measurement, and owner launch disposition',
    ],
  };
}

function read(root, site = null) {
  const dir = path.join(root, DIR);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }

  return files
    .map(file => {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return { ...item, evidence_summary: evidenceSummary(root, item) };
      } catch {
        return null;
      }
    })
    .filter(
      item => item && (!site || String(item.site).toLowerCase() === String(site).toLowerCase())
    );
}

module.exports = { DIR, read };
