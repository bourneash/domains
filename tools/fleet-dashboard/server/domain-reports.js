'use strict';

// Cheap, deterministic domain-manager reporting. This is deliberately separate
// from the model runner: scripts inspect the whole fleet, then the staggered
// queue gives every managed site a lightweight model review.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const executiveIntel = require('./executive-intel');
const executiveRunner = require('../../executive/runner');
const executive = require('./executive');
const eventstore = require('./eventstore');

const CADENCES = new Set(['six_hour', 'daily', 'weekly', 'deep_dive']);
const EXCLUDED_SITES = new Set(['3boobs.com']);

function reportDir(root) {
  return path.join(root, 'tools', 'executive', 'data', 'reports');
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_.-]/gi, '-');
}

function siteRow(rows, site) {
  return (rows || []).find(row => row && (row.site || row.domain) === site) || null;
}

function sourceState(intelligence, name) {
  const source = intelligence.sources?.[name];
  if (!source)
    return { state: 'unavailable', source: name, observed_at: null, error: 'not reported' };
  return {
    state: source.ok === false ? 'error' : 'available',
    source: name,
    observed_at: source.observed_at || source.generated_at || null,
    error: source.error || null,
  };
}

function siteReport(site, intelligence, cadence) {
  const support = intelligence.decision_support || {};
  const analytics = support.analytics?.sites?.[site] || null;
  const seo = siteRow(support.seo?.sites, site);
  const usage = siteRow(support.ai_usage?.by_site, site);
  const priorities = siteRow(support.priorities?.scorecards, site);
  const exceptions = [];
  const missingEvidence = [];
  const evidence = [];

  if (!analytics || analytics.configured === false) missingEvidence.push('analytics_unavailable');
  if (analytics?.ga4?.status && analytics.ga4.status !== 'ok') exceptions.push('ga4_source_issue');
  if (analytics?.gsc?.status && analytics.gsc.status !== 'ok') exceptions.push('gsc_source_issue');
  if (Number(seo?.high) > 0) exceptions.push('high_priority_seo_actions');
  if (Number(seo?.conversions) > 0 || Number(seo?.clicks) > 0)
    evidence.push('observed_search_or_conversion_signal');
  if (Number(usage?.errors) > 0) exceptions.push('ai_errors_observed');
  if (Number(priorities?.opportunity_score) > 0) evidence.push('priority_score_available');

  const sourceHealth = [
    sourceState(intelligence, 'analytics'),
    sourceState(intelligence, 'seo_intelligence'),
    sourceState(intelligence, 'revenue'),
    sourceState(intelligence, 'ai_usage'),
    sourceState(intelligence, 'operations'),
  ];
  const report = {
    site,
    cadence,
    observed_at: new Date().toISOString(),
    classification: exceptions.length ? 'exception' : 'no_change_supported',
    evidence,
    exceptions: [...new Set(exceptions)],
    missing_evidence: [...new Set(missingEvidence)],
    metrics: {
      analytics: analytics || { unavailable: true },
      seo: seo || { unavailable: true },
      ai_usage: usage || { unavailable: true },
      priority: priorities || { unavailable: true },
    },
    source_health: sourceHealth,
    interpretation:
      exceptions.length > 0
        ? 'Measured exception or signal found; domain-manager deep dive may be warranted.'
        : 'No supported exception found in the available window. Absence of evidence is not zero performance.',
    next_action: exceptions.length
      ? 'Review evidence, freshness, attribution limits, and decide whether to invoke a domain-manager deep dive.'
      : 'Retain the compact report and avoid spending model/tooling budget on a deep dive without a new signal.',
  };
  return report;
}

function selectSites({ cadence, sites, reports, focusSite }) {
  if (focusSite) return sites.filter(site => site === focusSite);
  if (cadence === 'six_hour') {
    return sites;
  }
  return sites;
}

async function generate({ root, cadence = 'six_hour', focusSite = null, now = new Date() } = {}) {
  if (!CADENCES.has(cadence)) throw new Error(`invalid report cadence: ${cadence}`);
  const sites = executiveRunner.executiveSites(root).filter(site => !EXCLUDED_SITES.has(site));
  if (focusSite && !sites.includes(focusSite)) throw new Error('focus site is not managed');
  const intelligence = await executiveIntel.collect({ root, sites });
  const initial = sites.map(site => siteReport(site, intelligence, cadence));
  const selected = selectSites({ cadence, sites, reports: initial, focusSite });
  const reports = initial.filter(row => selected.includes(row.site));
  const deepDiveCandidates = reports.map(row => ({
    site: row.site,
    reasons: row.exceptions.length ? row.exceptions : ['routine_fleet_review'],
    recommended_role: 'domain-manager',
    reason: row.exceptions.length
      ? 'review the measured exception and source freshness'
      : 'perform the recurring lightweight site review and surface growth opportunities',
  }));
  const globalExceptions = Object.values(intelligence.sources || {})
    .filter(source => source && source.ok === false)
    .map(source => `${source.source}_source_error`);
  const report = {
    report_id: crypto.randomUUID(),
    cadence,
    generated_at: now.toISOString(),
    scope: { managed_sites: sites, excluded_sites: [...EXCLUDED_SITES] },
    summary: {
      sites_considered: sites.length,
      sites_reported: reports.length,
      exceptions: reports.filter(row => row.exceptions.length).length,
      deep_dive_candidates: deepDiveCandidates.length,
      global_exceptions: [...new Set(globalExceptions)],
    },
    reports,
    deep_dive_candidates: deepDiveCandidates,
    global_exceptions: [...new Set(globalExceptions)],
    source_contract:
      'Every field is sourced from the executive intelligence snapshot. Unavailable or stale data is labeled; no missing metric is treated as zero and no revenue forecast is inferred.',
  };
  const dir = reportDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safeName(cadence)}-${safeName(report.generated_at)}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  const store = eventstore.open(root);
  const audit = executive.action(store, {
    actor: 'system',
    action_type: 'observe',
    summary: `${cadence} domain-manager report generated`,
    target_type: 'domain-report',
    target_id: report.report_id,
  });
  executive.finishAction(store, audit.action_id, {
    status: 'completed',
    result: { report_id: report.report_id, cadence, file, summary: report.summary },
  });
  store.record({
    event_type: 'executive.domain-report.generated',
    source: 'domain-reports',
    entity_type: 'domain-report',
    entity_id: report.report_id,
    correlation_id: `domain-report:${report.report_id}`,
    payload: { cadence, file, summary: report.summary },
  });
  store.close();
  return { ...report, file };
}

function recent(root, limit = 20) {
  const dir = reportDir(root);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map(file => {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return {
          _file: file,
          report_id: row.report_id,
          cadence: row.cadence,
          generated_at: row.generated_at,
          summary: row.summary,
          deep_dive_candidates: row.deep_dive_candidates,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))
    .slice(0, Math.max(1, Number(limit) || 20))
    .map(({ _file, ...row }) => row);
}

function get(root, reportId) {
  const dir = reportDir(root);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (report.report_id === reportId) return report;
    } catch {
      /* skip corrupt historical files */
    }
  }
  return null;
}

module.exports = { CADENCES: [...CADENCES], reportDir, siteReport, generate, recent, get };
