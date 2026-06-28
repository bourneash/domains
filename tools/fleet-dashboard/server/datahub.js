'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const API = process.env.DATAHUB_API || 'http://host.docker.internal:4760';
const ROOT = process.env.FD_DOMAINS_ROOT || `${process.env.HOME || '/home/jesse'}/projects/domains`;
const REG = path.join(ROOT, 'tools', 'data-hub', 'registry');

async function _get(pathname, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${pathname}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`hub ${pathname} → HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function health() { return _get('/health'); }
async function egress(limit = 60) {
  const r = await _get(`/egress?limit=${encodeURIComponent(limit)}`);
  return r.ok === false ? { ...r, events: [] } : r;
}
async function sources() {
  const r = await _get('/sources');
  return r.ok === false ? { ...r, sources: [] } : r;
}
async function datasets() {
  const r = await _get('/datasets');
  return r.ok === false ? { ...r, datasets: [] } : r;
}

function _loadYaml(file, key) {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(REG, file), 'utf8')) || {};
    return doc[key] || (key === 'subscriptions' ? {} : []);
  } catch (e) {
    return key === 'subscriptions' ? {} : [];
  }
}

// Build the source×site matrix purely from the registry on disk (hub-independent).
function matrix() {
  const srcList = _loadYaml('sources.yaml', 'sources');
  const subs = _loadYaml('subscriptions.yaml', 'subscriptions');
  const sources = srcList.map((s) => ({
    id: s.id, tags: s.tags || [], type: s.type || 'rss',
    policy: s.policy || 'vpn', exit: s.exit || 'any',
  }));
  const sites = Object.keys(subs).sort();
  const rss = [];
  const datasets = [];
  for (const site of sites) {
    const sub = subs[site] || {};
    const items = sub.items || {};
    const any = items.tags_any || [];
    const all = items.tags_all || [];
    const matched = sources
      .filter((s) => s.type === 'rss')
      .filter((s) => {
        const t = s.tags;
        const anyOk = any.length ? any.some((x) => t.includes(x)) : false;
        const allOk = all.length ? all.every((x) => t.includes(x)) : false;
        return anyOk || allOk;
      })
      .map((s) => s.id);
    rss.push({ site, tags_any: any, tags_all: all, matched_sources: matched });
    datasets.push({ site, keys: sub.datasets || [] });
  }
  return { sites, sources, rss, datasets };
}

module.exports = { health, egress, sources, datasets, matrix, API };
