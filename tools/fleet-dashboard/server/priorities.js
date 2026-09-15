'use strict';

const registry = require('./fleetregistry');
const tasks = require('./tasks');

function build({ root, discoveredSites, seo, revenue, analyticsHealth = {}, aiUsage = {} }) {
  const reg = registry.read(root);
  const discovered = new Set(discoveredSites || []);
  const live = reg.sites.filter(s => s.lifecycle === 'live');
  const analytics = analyticsHealth.sites || {};
  const items = [];

  for (const action of seo.actions || []) {
    items.push({
      id: `recommendation:${action.key}`,
      kind: 'growth', site: action.site, site_id: `site:${action.site}`,
      title: action.title, evidence: action.evidence, score: action.rankScore || action.score || 0,
      confidence: action.page || action.query ? 'high' : 'medium',
      state: action.filed ? 'filed' : 'ready', source: 'seo-intelligence',
      proxy_value: action.valueScore || 0, expected_profit_usd: null,
      action_key: action.key,
    });
  }

  for (const site of live) {
    if (!discovered.has(site.domain)) items.push(gap(site, 98, 'Registry says live, but no operational checkout is discoverable', 'fleet-registry'));
    if (site.capabilities.includes('analytics') && !analytics[site.domain])
      items.push(gap(site, 88, 'Restore GA4/GSC collection for a live analytics-enabled site', 'analytics-health'));
  }

  let allTasks = [];
  try { allTasks = tasks.listAll(root, discoveredSites || []); } catch { /* surface remains useful */ }
  const installedRoles = new Map();
  for (const task of allTasks) {
    if (!task.assigned_role || !['backlog', 'in-progress'].includes(task.column)) continue;
    const key = `${task.site}:${task.assigned_role}`;
    if (!installedRoles.has(key)) installedRoles.set(key, roleInstalled(root, task.site, task.assigned_role));
    if (!installedRoles.get(key)) items.push({
      id: `task-owner:${task.site}:${task.file}`, kind: 'execution', site: task.site, site_id: `site:${task.site}`,
      title: `Reassign task owned by missing role: ${task.title}`, evidence: `${task.assigned_role} is not installed for ${task.site}`,
      score: 91, confidence: 'high', state: 'blocked', source: 'task-board', proxy_value: 0,
      expected_profit_usd: null, task: { file: task.file, column: task.column },
    });
  }

  const activeSeoKeys = new Set((seo.actions || []).map(row => row.key));
  const today = new Date().toISOString().slice(0, 10);
  for (const task of allTasks) {
    if (task.column !== 'done' || task.source !== 'seo-intelligence' || !task.source_id || !task.measurement_due) continue;
    if (task.measurement_due > today) continue;
    const stillDetected = activeSeoKeys.has(task.source_id);
    items.push({ id: `measurement:${task.site}:${task.task_id || task.file}`, kind: 'measurement', site: task.site,
      site_id: `site:${task.site}`, title: stillDetected ? `Measure completed work: ${task.title}` : `Verify likely resolved signal: ${task.title}`,
      evidence: stillDetected ? 'The originating signal is still detected after its measurement window.' : 'The originating signal is no longer detected; verify the change caused the improvement.',
      score: stillDetected ? 94 : 82, confidence: stillDetected ? 'high' : 'medium', state: 'ready', source: 'outcome-monitor',
      proxy_value: 0, expected_profit_usd: null, task: { file: task.file, column: task.column, task_id: task.task_id },
      correlation_id: task.correlation_id, outcome_candidate: stillDetected ? 'not-improved' : 'resolved' } );
  }

  items.sort((a, b) => b.score - a.score || b.proxy_value - a.proxy_value || a.site.localeCompare(b.site));
  const costBySite = Object.fromEntries((aiUsage.by_site || []).map(row => [row.site, Number(row.total_cost_usd) || 0]));
  const revenueBySite = Object.fromEntries((revenue?.attribution || []).filter(row => row.site).map(row => [row.site, Number(row.commission_income) || 0]));
  const seoBySite = Object.fromEntries((seo.sites || []).map(row => [row.site, row]));
  const scorecards = live.map(site => {
    const signal = seoBySite[site.domain] || {};
    const ai_cost_usd = costBySite[site.domain] || 0;
    const revenue_usd = revenueBySite[site.domain] ?? null;
    const margin_usd = revenue_usd == null ? null : revenue_usd - ai_cost_usd;
    const health = discovered.has(site.domain) && (!site.capabilities.includes('analytics') || analytics[site.domain]);
    const opportunity = Math.min(100, (signal.high || 0) * 20 + (signal.actions || 0) * 4 + (signal.conversions || 0) * 2);
    const allocation = !health ? 'repair' : revenue_usd == null ? (opportunity >= 50 ? 'invest-test' : 'maintain') : margin_usd > 0 ? 'invest' : opportunity >= 60 ? 'repair-monetization' : 'review';
    return { site: site.domain, site_id: site.site_id, lifecycle: site.lifecycle, allocation, opportunity_score: opportunity,
      sessions: signal.sessions || 0, conversions: signal.conversions || 0, ai_cost_usd, revenue_usd, margin_usd,
      profit_attributable: revenue_usd != null };
  }).sort((a, b) => b.opportunity_score - a.opportunity_score || a.site.localeCompare(b.site));
  const coverage = {
    registry_sites: reg.sites.length, live_sites: live.length, discovered_sites: discovered.size,
    analytics_sites: Object.keys(analytics).length,
    revenue_connected: Boolean(revenue && revenue.connected), revenue_attributed: false,
  };
  return {
    generated_at: new Date().toISOString(), value_basis: revenue?.has_data ? 'revenue-unattributed' : 'proxy',
    notice: 'Expected profit remains null until revenue is attributable by site and content.',
    coverage, totals: { recommendations: items.length, ready: items.filter(x => x.state === 'ready').length, blocked: items.filter(x => x.state === 'blocked').length },
    items: items.slice(0, 250), scorecards, registry_ok: reg.ok, registry_error: reg.error || null,
  };
}

function roleInstalled(root, site, role) {
  const fs = require('node:fs'), path = require('node:path');
  const ops = path.join(root, 'sites', site, 'ops');
  const candidates = [path.join(ops, 'roles', `${role}.md`), path.join(ops, 'scripts', `run-${role}.sh`)];
  if (candidates.some(fs.existsSync)) return true;
  try { return fs.readFileSync(path.join(ops, 'crontab.docker'), 'utf8').includes(role); } catch { return false; }
}

function gap(site, score, title, source) {
  return { id: `gap:${source}:${site.domain}`, kind: 'coverage', site: site.domain, site_id: site.site_id,
    title, evidence: `lifecycle=${site.lifecycle}; capabilities=${site.capabilities.join(',')}`, score,
    confidence: 'high', state: 'blocked', source, proxy_value: 0, expected_profit_usd: null };
}

module.exports = { build, roleInstalled };
