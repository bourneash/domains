'use strict';

const fs = require('node:fs');
const path = require('node:path');

function amazonSummary(root) {
  const outDir = path.join(root, 'tools', 'amz-stats', 'out');
  const earningsFile = path.join(outDir, 'earnings-latest.json');
  const sessionFile = path.join(outDir, '.session.json');
  const base = {
    source: 'amazon-associates',
    connected: fs.existsSync(sessionFile),
    has_data: false,
    message: fs.existsSync(sessionFile)
      ? 'No earnings export has completed yet.'
      : 'Associates earnings session is not connected. Run amz-stats save-session once.',
  };
  if (!fs.existsSync(earningsFile)) return base;

  try {
    const rows = JSON.parse(fs.readFileSync(earningsFile, 'utf8'));
    if (!Array.isArray(rows) || !rows.length) return base;
    const number = (row, key) => Number(row[key] || 0);
    const dates = rows.map(row => row.date || row.report_date).filter(Boolean).sort();
    return {
      ...base,
      has_data: true,
      message: null,
      from: dates[0] || null,
      through: dates.at(-1) || null,
      clicks: rows.reduce((sum, row) => sum + number(row, 'clicks'), 0),
      ordered_items: rows.reduce((sum, row) => sum + number(row, 'ordered_items'), 0),
      shipped_items: rows.reduce((sum, row) => sum + number(row, 'shipped_items'), 0),
      commission_income: rows.reduce((sum, row) => sum + number(row, 'commission_income'), 0),
      fetched_at: fs.statSync(earningsFile).mtime.toISOString(),
    };
  } catch (error) {
    return { ...base, error: String(error.message || error), message: 'The latest earnings export is unreadable.' };
  }
}

module.exports = { amazonSummary };
