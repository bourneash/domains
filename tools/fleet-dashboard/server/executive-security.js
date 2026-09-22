'use strict';

// Compact, read-only security evidence for the executive brief. This adapter
// deliberately consumes the Fleet Manager's existing checks instead of giving
// a model shell, credential, scanner, or production access.

const sitefacts = require('./sitefacts');
const fleetdoctor = require('./fleetdoctor');

function collect({ sites = [] } = {}) {
  const matrix = sitefacts.matrix(sites);
  const details = sites.map(site => sitefacts.siteDetail(site));
  const securityRows = details.map(detail => {
    const facts = Object.fromEntries((detail.rows || []).map(row => [row.key, row.value]));
    return {
      site: detail.site,
      checked_at: detail.checkedAt ? new Date(detail.checkedAt).toISOString() : null,
      tls_expiry_days: detail.tlsExpiryDays,
      security_txt: facts['legal.has_security_txt'] ?? null,
      privacy_page: facts['legal.has_privacy_page'] ?? null,
      terms_page: facts['legal.has_terms_page'] ?? null,
      affiliate_disclosure: facts['legal.has_affiliate_disclosure'] ?? null,
    };
  });
  const counts = { green: 0, yellow: 0, unknown: 0 };
  for (const row of matrix.rows || []) {
    const state = row.cells?.legal || 'unknown';
    if (state === 'green') counts.green += 1;
    else if (state === 'yellow') counts.yellow += 1;
    else counts.unknown += 1;
  }
  const tlsExpiringSoon = securityRows
    .filter(row => Number.isFinite(row.tls_expiry_days) && row.tls_expiry_days <= 30)
    .map(row => ({ site: row.site, days: row.tls_expiry_days }));
  return {
    generated_at: new Date().toISOString(),
    scope: { sites: [...sites], site_count: sites.length },
    sitefacts: {
      last_sweep: matrix.lastSweep ? new Date(matrix.lastSweep).toISOString() : null,
      legal_family: counts,
      tls_expiring_within_30_days: tlsExpiringSoon,
      sites: securityRows,
    },
    fleet_doctor: fleetdoctor.all(),
    limitations: [
      'Read-only operational baseline; not a penetration test or security certification.',
      'Missing optional security.txt or legal-page evidence is a review signal, not proof of a vulnerability.',
      'No credentials, private source, container shell, exploit, or production mutation is available to the Security role.',
    ],
  };
}

module.exports = { collect };
