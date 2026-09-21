'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TAG_CACHE_MS = 5 * 60 * 1000;
const tagCache = new Map();

function trackingId(row) {
  return (
    String(row.tracking_id || row.tracking_id_1 || row.store_id || row.associate_id || '').trim() ||
    null
  );
}

function discoverTrackingTags(root) {
  const cached = tagCache.get(root);
  if (cached && Date.now() - cached.at < TAG_CACHE_MS) return cached.value;
  const sitesDir = path.join(root, 'sites');
  const out = {};
  let sites = [];
  try {
    sites = fs.readdirSync(sitesDir);
  } catch {
    return out;
  }
  for (const site of sites) {
    const roots = [path.join(sitesDir, site, 'site', 'src'), path.join(sitesDir, site, 'ops')];
    const tags = new Set();
    for (const dir of roots)
      scan(dir, file => {
        if (
          !/(?:affiliate|amazon|associate|disclosure|config|tracked|hub).*\.(?:js|ts|astro|json|ya?ml|md)$/i.test(
            path.basename(file)
          )
        )
          return;
        let text = '';
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          return;
        }
        for (const match of text.matchAll(/\b([a-z0-9][a-z0-9-]{2,}-20)\b/gi))
          tags.add(match[1].toLowerCase());
      });
    for (const tag of tags) {
      if (!out[tag]) out[tag] = [];
      out[tag].push(site);
    }
  }
  tagCache.set(root, { at: Date.now(), value: out });
  return out;
}

function scan(dir, visit) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
      continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file, visit);
    else if (entry.isFile()) visit(file);
  }
}

function amazonSummary(root) {
  const outDir = path.join(root, 'tools', 'amz-stats', 'out');
  const earningsFile = path.join(outDir, 'earnings-latest.json');
  const sessionFile = path.join(outDir, '.session.json');
  const base = {
    source: 'amazon-associates',
    connected: fs.existsSync(sessionFile),
    has_data: false,
    owner_action_required:
      'Run `docker compose exec -it collector amz-stats pull-earnings --out-dir /work/out` and complete the Amazon Associates login/2FA once to refresh attributable earnings.',
    message: fs.existsSync(sessionFile)
      ? 'No earnings export has completed yet.'
      : 'Associates earnings session is not connected. Run amz-stats save-session once.',
  };
  if (!fs.existsSync(earningsFile)) return base;

  try {
    const payload = JSON.parse(fs.readFileSync(earningsFile, 'utf8'));
    // Interactive Associates exports are wrapped as { pulled_at, rows };
    // retain support for the older bare-array format.
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.rows)
        ? payload.rows
        : [];
    if (!rows.length) return base;
    const number = (row, ...keys) => {
      for (const key of keys) {
        const value = Number(row[key]);
        if (Number.isFinite(value)) return value;
      }
      return 0;
    };
    const dates = rows
      .map(row => row.date || row.report_date)
      .filter(Boolean)
      .sort();
    const tagMap = discoverTrackingTags(root);
    const attributed = {};
    for (const row of rows) {
      const tag = trackingId(row)?.toLowerCase();
      const sites = tag ? tagMap[tag] || [] : [];
      const site = sites.length === 1 ? sites[0] : null;
      const key = site || (tag ? `unmapped:${tag}` : 'unattributed');
      const cur = attributed[key] || {
        site,
        tracking_id: tag,
        rows: 0,
        clicks: 0,
        ordered_items: 0,
        commission_income: 0,
      };
      cur.rows += 1;
      cur.clicks += number(row, 'clicks');
      cur.ordered_items += number(row, 'ordered_items', 'items_ordered');
      cur.commission_income += number(
        row,
        'commission_income',
        'total_earnings',
        'items_shipped_earnings'
      );
      attributed[key] = cur;
    }
    return {
      ...base,
      has_data: true,
      owner_action_required: null,
      message: null,
      from: dates[0] || payload?.pulled_at?.slice?.(0, 10) || null,
      through: dates.at(-1) || payload?.pulled_at?.slice?.(0, 10) || null,
      clicks: rows.reduce((sum, row) => sum + number(row, 'clicks'), 0),
      ordered_items: rows.reduce(
        (sum, row) => sum + number(row, 'ordered_items', 'items_ordered'),
        0
      ),
      shipped_items: rows.reduce(
        (sum, row) => sum + number(row, 'shipped_items', 'items_shipped'),
        0
      ),
      commission_income: rows.reduce(
        (sum, row) =>
          sum + number(row, 'commission_income', 'total_earnings', 'items_shipped_earnings'),
        0
      ),
      attribution: Object.values(attributed),
      attributed_income: Object.values(attributed)
        .filter(r => r.site)
        .reduce((n, r) => n + r.commission_income, 0),
      attribution_complete: Object.values(attributed).every(r => Boolean(r.site)),
      fetched_at: fs.statSync(earningsFile).mtime.toISOString(),
    };
  } catch (error) {
    return {
      ...base,
      error: String(error.message || error),
      message: 'The latest earnings export is unreadable.',
    };
  }
}

module.exports = { amazonSummary, trackingId, discoverTrackingTags };
