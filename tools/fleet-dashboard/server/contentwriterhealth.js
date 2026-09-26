'use strict';
const fs = require('node:fs');
const path = require('node:path');
const WINDOW_MS = 24 * 60 * 60 * 1000;
const LOG_RE = /^content-writer(?:-\d)?-/;
function health(root, slugs, now = Date.now()) {
  const sites = [];
  for (const site of slugs) {
    const dir = path.join(root, 'sites', site, 'ops', 'logs');
    const counts = { deferred: 0, sandbox: 0, quality_gate: 0, build: 0, succeeded: 0 }; let newest = 0;
    try { for (const name of fs.readdirSync(dir)) { if (!LOG_RE.test(name)) continue; const file = path.join(dir, name); const stat = fs.statSync(file); if (now - stat.mtimeMs > WINDOW_MS) continue; newest = Math.max(newest, stat.mtimeMs); const text = fs.readFileSync(file, 'utf8'); counts.deferred += (text.match(/content-writer deferred/g) || []).length; counts.sandbox += (text.match(/sandbox smoke test failed/g) || []).length; counts.quality_gate += (text.match(/deterministic content-quality precheck failed/g) || []).length; counts.build += (text.match(/authoritative content build failed/g) || []).length; counts.succeeded += (text.match(/content transaction committed, pushed/g) || []).length; } } catch { /* site may have no writer logs */ }
    const alerts = []; if (counts.deferred >= 3) alerts.push({ kind: 'sandbox-deferred', severity: 'high', count: counts.deferred }); if (counts.quality_gate >= 2) alerts.push({ kind: 'quality-gate', severity: 'high', count: counts.quality_gate }); if (counts.build >= 2) alerts.push({ kind: 'build-failure', severity: 'medium', count: counts.build });
    if (alerts.length || newest) sites.push({ site, counts, alerts, newest: newest ? new Date(newest).toISOString() : null });
  }
  return { window_hours: 24, sites, alerts: sites.flatMap(s => s.alerts.map(a => ({ ...a, site: s.site }))) };
}
module.exports = { health };
