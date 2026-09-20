'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPORT_RE = /^backlinks-(\d{4}-\d{2}-\d{2})\.md$/;
const MAX_EXCERPT = 500;

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function daysSince(date, now = new Date()) {
  if (!date) return null;
  const then = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  return Math.max(
    0,
    Math.floor((Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z') - then) / 86400000)
  );
}

function reportEvidence(text) {
  const body = String(text || '').toLowerCase();
  const sources = [];
  if (/common crawl|crawl corpus|tier 0/.test(body)) sources.push('common-crawl');
  if (/bing_webmaster|bing webmaster/.test(body)) sources.push('bing');
  if (/moz_api|moz api|domain rating|da\/dr|referring-domain/.test(body)) sources.push('moz');
  if (/ahrefs/.test(body)) sources.push('ahrefs');
  if (/dataforseo/.test(body)) sources.push('dataforseo');
  // Narrative claims such as "confirmed" or "backlink list" are not enough:
  // the fleet's existing reports often mention the missing sources while
  // explicitly declining to produce a number. Require a numeric export or a
  // source response marker before calling a report measured.
  const measured =
    /(?:referring domains?|backlinks?)\s*[:=]\s*\d+/i.test(body) ||
    /(?:moz|bing|ahrefs|dataforseo)[^\n]{0,120}(?:export|response|api returned|links? found)/i.test(
      body
    );
  return { sources: [...new Set(sources)], measured };
}

function excerpt(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('---') && !line.startsWith('#'));
  return lines.join(' ').replace(/[*`]/g, '').slice(0, MAX_EXCERPT);
}

function readReports(siteDir) {
  const dir = path.join(siteDir, 'ops', 'seo');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map(name => {
      const match = REPORT_RE.exec(name);
      if (!match) return null;
      const file = path.join(dir, name);
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      const evidence = reportEvidence(text);
      return {
        date: isoDate(match[1]),
        file: path.relative(path.dirname(siteDir), file).replaceAll(path.sep, '/'),
        bytes: Buffer.byteLength(text),
        excerpt: excerpt(text),
        ...evidence,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function siteNames(root) {
  const dir = path.join(root, 'sites');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, '.git')))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function classify(reports, now) {
  if (!reports.length)
    return {
      status: 'missing',
      label: 'Missing baseline',
      priority: 'high',
      recommendation:
        'Run an initial backlink baseline and record its sources before doing outreach.',
    };
  const latest = reports[0];
  const age = daysSince(latest.date, now);
  if (latest.measured && age != null && age <= 90)
    return {
      status: 'current',
      label: 'Measured baseline',
      priority: 'low',
      recommendation:
        'Keep monitoring; refresh the backlink export when the source index changes or quarterly.',
    };
  return {
    status: age != null && age > 90 ? 'stale' : 'baseline',
    label: age != null && age > 90 ? 'Stale baseline' : 'Unquantified baseline',
    priority: age != null && age > 90 ? 'medium' : 'high',
    recommendation: latest.measured
      ? 'Refresh the backlink capture and compare referring domains, anchors, and lost links.'
      : 'Upgrade this report with a real Bing/Moz/Ahrefs/DataForSEO export; the current evidence is not a numeric backlink capture.',
  };
}

function buildSnapshot(root, now = new Date()) {
  const rows = siteNames(root).map(site => {
    const reports = readReports(path.join(root, 'sites', site));
    const classification = classify(reports, now);
    const latest = reports[0] || null;
    return {
      site,
      ...classification,
      reportCount: reports.length,
      latestDate: latest?.date || null,
      latestAgeDays: latest ? daysSince(latest.date, now) : null,
      measured: Boolean(latest?.measured),
      sources: latest?.sources || [],
      latestReport: latest,
      reports,
    };
  });
  const counts = Object.fromEntries(
    ['current', 'baseline', 'stale', 'missing'].map(key => [
      key,
      rows.filter(row => row.status === key).length,
    ])
  );
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    totals: {
      sites: rows.length,
      reports: rows.reduce((n, row) => n + row.reportCount, 0),
      ...counts,
    },
    coverage: rows.length
      ? Math.round((rows.filter(row => row.status !== 'missing').length / rows.length) * 100)
      : 0,
    sources: [...new Set(rows.flatMap(row => row.sources))].sort(),
    sites: rows,
  };
}

function writeSnapshot(root, snapshot) {
  const dataDir = path.join(root, 'tools', 'fleet-dashboard', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'backlinks-latest.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
  fs.appendFileSync(
    path.join(dataDir, 'backlinks-history.jsonl'),
    `${JSON.stringify({
      generatedAt: snapshot.generatedAt,
      totals: snapshot.totals,
      coverage: snapshot.coverage,
    })}\n`
  );
  return snapshot;
}

if (require.main === module) {
  const rootArg = process.argv[2] === '--root' ? process.argv[3] : process.env.DOMAINS_ROOT;
  const root = path.resolve(rootArg || path.join(__dirname, '..', '..'));
  const snapshot = writeSnapshot(root, buildSnapshot(root));
  process.stdout.write(`${JSON.stringify(snapshot.totals)} coverage=${snapshot.coverage}%\n`);
}

module.exports = {
  buildSnapshot,
  classify,
  daysSince,
  readReports,
  reportEvidence,
  siteNames,
  writeSnapshot,
};
