'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const compliance = require('./compliance');

test('analyze passes a banner with equal choices and default-denied GA4', () => {
  const source = `
    <a href="/privacy">Privacy</a><a href="/terms">Terms</a>
    <div class="cookie-banner" role="dialog">Cookie preferences
      <button>Accept all</button><button>Reject all</button>
    </div>
    <script>gtag('consent', 'default', { analytics_storage: 'denied' });</script>
    <script src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234567"></script>`;
  const row = compliance.analyze(source, { url: 'https://example.com/' });
  assert.equal(row.status, 'pass');
  assert.equal(row.checks.banner, true);
  assert.equal(row.checks.ga4, true);
  assert.equal(row.checks.gaConsentGated, true);
  assert.deepEqual(row.measurementIds, ['G-ABC1234567']);
  assert.match(row.evidence.bannerWording, /Cookie preferences/);
  assert.equal(row.evidence.acceptLabel, 'Accept all');
  assert.equal(row.evidence.rejectLabel, 'Reject all');
  assert.equal(row.evidence.privacyUrl, 'https://example.com/privacy');
  assert.equal(row.evidence.termsUrl, 'https://example.com/terms');
});

test('analyze fails GA4 that loads without consent evidence', () => {
  const source = `<div class="cookie-banner">Cookies <button>Accept</button></div>
    <script src="https://www.googletagmanager.com/gtag/js?id=G-ZYX9876543"></script>`;
  const row = compliance.analyze(source, { url: 'https://example.com/' });
  assert.equal(row.status, 'fail');
  assert.equal(row.checks.reject, false);
  assert.equal(row.checks.gaConsentGated, false);
  assert.match(row.failures.join(' '), /reject/);
  assert.match(row.failures.join(' '), /GA4/);
});

test('scriptUrls keeps only unique same-origin bundles', () => {
  const html = `<script src="/assets/app.js"></script><script src="/assets/app.js"></script><script src="https://evil.test/x.js"></script>`;
  assert.deepEqual(compliance.scriptUrls(html, 'https://example.com/'), ['https://example.com/assets/app.js']);
});

test('measurement ID detection ignores lookalike UI tokens', () => {
  const row = compliance.analyze('G-GRADIENT G-RELAXED G-ABC1234567', { url: 'https://example.com/' });
  assert.deepEqual(row.measurementIds, ['G-ABC1234567']);
});

test('compiled React router paths count only with matching legal-page content', () => {
  const source = `
    <div class="cookie-banner"><button>Accept</button><button>Reject</button>Cookie consent</div>
    createBrowserRouter([{path:"/privacy",element:Privacy},{path:"/terms",element:Terms}]);
    "Privacy Policy" "Information we collect" "Terms of Use" "By using 0xRoulette, you agree"`;
  const row = compliance.analyze(source, { url: 'https://0xroulette.com/' });
  assert.equal(row.checks.privacy, true);
  assert.equal(row.checks.terms, true);
  assert.equal(row.evidence.privacyUrl, 'https://0xroulette.com/privacy');
  assert.equal(row.evidence.termsUrl, 'https://0xroulette.com/terms');

  const mentionOnly = compliance.analyze('See /privacy and /terms sometime', { url: 'https://example.com/' });
  assert.equal(mentionOnly.checks.privacy, false);
  assert.equal(mentionOnly.checks.terms, false);
});

test('bundle evidence extracts human labels and ignores minified code identifiers', () => {
  const source = `const acceptsBooleans=true, consent="denied";
    h("p",{children:"We use a privacy-respecting analytics cookie. No ad tracking."});
    h("button",{children:"Decline"});h("button",{children:"Accept"});`;
  const row = compliance.analyze(source, { url: 'https://example.com/' });
  assert.equal(row.evidence.acceptLabel, 'Accept');
  assert.equal(row.evidence.rejectLabel, 'Decline');
  assert.equal(row.evidence.bannerWording, 'We use a privacy-respecting analytics cookie. No ad tracking.');
});

test('scanSite classifies HTTP and unsupported-content unknowns', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async () => ({
    ok: false,
    status: 503,
    headers: { get: () => 'text/html' },
  });
  const httpRow = await compliance.scanSite('http-error.test');
  assert.equal(httpRow.status, 'unknown');
  assert.equal(httpRow.errorType, 'http');
  assert.equal(httpRow.httpStatus, 503);

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/pdf' },
    text: async () => '',
  });
  const contentRow = await compliance.scanSite('pdf.test');
  assert.equal(contentRow.status, 'unknown');
  assert.equal(contentRow.errorType, 'unsupported-content');
});

test('fleet scans expose progress and retain per-site history', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  global.fetch = async () => {
    await gate;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<div class="cookie-banner"><button>Accept</button><button>Reject</button>Cookie consent</div><a href="/privacy">Privacy</a><a href="/terms">Terms</a>',
    };
  };

  const pending = compliance.scanAll(['progress.test']);
  assert.equal(compliance.progress().running, true);
  assert.equal(compliance.progress().total, 1);
  release();
  await pending;
  assert.equal(compliance.progress().running, false);
  assert.equal(compliance.progress().completed, 1);
  const row = compliance.matrix(['progress.test'])[0];
  assert.equal(row.status, 'pass');
  assert.equal(row.history.length, 1);
  assert.equal(row.history[0].change, 'new');
  assert.equal(compliance.fleetHistory(['progress.test']).at(-1).passRate, 100);
});
