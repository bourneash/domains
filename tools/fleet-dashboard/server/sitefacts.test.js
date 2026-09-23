'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sitefacts = require('./sitefacts');

test('browser compliance overrides an HTTP GA4 false-negative for consent-gated sites', () => {
  const facts = sitefacts._effectiveFacts(
    { 'http.ga4_present': false },
    { checks: { ga4: true, gaConsentGated: true } }
  );

  assert.equal(facts['http.ga4_present'], true);
});

test('HTTP GA4 result is unchanged without matching browser compliance evidence', () => {
  assert.equal(
    sitefacts._effectiveFacts(
      { 'http.ga4_present': false },
      { checks: { ga4: true, gaConsentGated: false } }
    )['http.ga4_present'],
    false
  );
  assert.equal(
    sitefacts._effectiveFacts(
      { 'http.ga4_present': false },
      { checks: { ga4: false, gaConsentGated: true } }
    )['http.ga4_present'],
    false
  );
});
