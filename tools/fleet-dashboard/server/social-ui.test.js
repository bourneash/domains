'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSocialUI() {
  const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const start = app.indexOf('/* ===================== SOCIAL ===================== */');
  const end = app.indexOf('/* ---- account editor ---- */', start);
  assert.ok(start >= 0 && end > start, 'social UI section markers should exist');

  const context = vm.createContext({
    Intl,
    URL,
    location: { origin: 'http://127.0.0.1:4754' },
    CSS: { escape: value => String(value) },
    document: {},
    esc: value =>
      String(value ?? '').replace(
        /[&<>"']/g,
        char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
      ),
    siteLink: site => `<a>${site}</a>`,
    safeHref: value => value || '',
    $: () => null,
    $$: () => [],
    api: async () => ({}),
    toast: () => {},
    applyUISnap: () => {},
    FRESH: true,
  });
  vm.runInContext(
    `${app.slice(start, end)}\n` +
      `globalThis.socialUI = { SOC, socQueryTerms, socTextMatch, socMatrixSites, socListRows, socMatrixHTML, socListHTML, socResetFilters };`,
    context
  );
  return context.socialUI;
}

function fixture() {
  const statuses = [
    { key: 'active', label: 'Active', tone: 'green', live: true },
    { key: 'blocked', label: 'Blocked', tone: 'orange', live: false, attention: true },
    { key: 'suspended', label: 'Suspended', tone: 'red', live: false, attention: true },
    { key: 'not_started', label: 'Not started', tone: 'gray', live: false },
  ];
  const account = overrides => ({
    id: 'acc-default',
    site: 'alpha.example',
    platform: 'bluesky',
    scope: 'brand',
    personaId: null,
    personaName: null,
    email: 'social@alpha.example',
    handle: 'alpha-news',
    profileUrl: 'https://example.test/alpha-news',
    status: 'active',
    tone: 'green',
    live: true,
    needsAttention: false,
    credsInVault: true,
    statusNote: 'Verified brand account',
    notes: '',
    tags: [],
    action: null,
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  });
  const accounts = [
    account({}),
    account({
      id: 'acc-pinterest',
      platform: 'pinterest',
      handle: 'alpha-pins',
      status: 'blocked',
      tone: 'orange',
      live: false,
      needsAttention: true,
      credsInVault: false,
      statusNote: 'Rate limit',
      updatedAt: '2026-08-21T10:00:00.000Z',
    }),
    account({
      id: 'acc-gamma',
      site: 'gamma.example',
      email: 'social@gamma.example',
      handle: 'gamma-live',
      status: 'suspended',
      tone: 'red',
      live: false,
      needsAttention: true,
      statusNote: 'Platform suspended this account',
      updatedAt: '2026-08-26T10:00:00.000Z',
    }),
  ];
  return {
    platforms: [
      { key: 'bluesky', label: 'Bluesky' },
      { key: 'pinterest', label: 'Pinterest' },
    ],
    statuses,
    siteCategories: [
      { key: 'active', label: 'Active' },
      { key: 'positioning_tbd', label: 'Positioning TBD' },
    ],
    sites: [
      { site: 'alpha.example', category: 'active', onDisk: true },
      { site: 'beta.example', category: 'positioning_tbd', onDisk: true },
      { site: 'gamma.example', category: 'active', onDisk: true },
    ],
    personas: [{ id: 'per-alpha', site: 'alpha.example', name: 'Alex Writer', beat: 'News' }],
    accounts,
    summary: {
      accounts: accounts.length,
      personas: 1,
      eligibleSites: 2,
      live: 1,
      needsAttention: 2,
    },
  };
}

const ui = loadSocialUI();

function reset() {
  ui.SOC.data = fixture();
  ui.SOC.mode = 'matrix';
  ui.SOC.group = 'none';
  ui.SOC.sort.matrix = { key: 'site', dir: 1 };
  ui.SOC.sort.list = { key: 'site', dir: 1 };
  ui.socResetFilters();
}

test.beforeEach(reset);

test('social search combines terms, keeps phrases, and supports exclusions', () => {
  assert.equal(ui.socTextMatch(['America Strikes', 'Bluesky active'], 'america active'), true);
  assert.equal(ui.socTextMatch(['America Strikes', 'Bluesky active'], 'america blocked'), false);
  assert.equal(ui.socTextMatch(['America Strikes', 'Bluesky active'], '"america strikes"'), true);
  assert.equal(ui.socTextMatch(['America Strikes', 'Bluesky active'], 'america -active'), false);

  ui.SOC.q = 'bluesky -suspended';
  assert.deepEqual(
    Array.from(ui.socMatrixSites(), site => site.site),
    ['alpha.example']
  );
});

test('matrix column filters narrow domains without hiding the filter controls', () => {
  ui.SOC.matrixFilters.platforms.bluesky = '__missing';
  assert.deepEqual(
    Array.from(ui.socMatrixSites(), site => site.site),
    ['beta.example']
  );

  const html = ui.socMatrixHTML();
  assert.match(html, /data-soc-filter="matrix:site"/);
  assert.match(html, /data-soc-filter="matrix:platform:bluesky"/);
  assert.match(html, /data-soc-sort="platform:bluesky"/);

  ui.SOC.matrixFilters.site = 'no-match';
  assert.match(ui.socMatrixHTML(), /No domains match the current filters/);
  assert.match(ui.socMatrixHTML(), /data-soc-filter="matrix:site"/);
});

test('toolbar status filtering removes matrix domains with no matching account', () => {
  ui.SOC.f.status = 'suspended';
  assert.deepEqual(
    Array.from(ui.socMatrixSites(), site => site.site),
    ['gamma.example']
  );
});

test('list column filters combine and each column remains sortable', () => {
  ui.SOC.mode = 'list';
  ui.SOC.listFilters.platform = 'pinterest';
  ui.SOC.listFilters.status = 'blocked';
  assert.deepEqual(
    Array.from(ui.socListRows(), account => account.id),
    ['acc-pinterest']
  );

  const html = ui.socListHTML();
  for (const key of [
    'site',
    'who',
    'email',
    'platform',
    'handle',
    'status',
    'credsInVault',
    'updatedAt',
    'statusNote',
  ]) {
    assert.match(html, new RegExp(`data-soc-sort="${key}"`));
    assert.match(html, new RegExp(`data-soc-filter="list:${key}"`));
  }
});

test('list sorting is natural and keeps missing values last', () => {
  ui.SOC.mode = 'list';
  ui.SOC.group = 'site';
  ui.SOC.sort.list = { key: 'updatedAt', dir: -1 };
  ui.SOC.data.accounts.push({
    ...ui.SOC.data.accounts[0],
    id: 'acc-undated',
    site: 'undated.example',
    updatedAt: '',
  });
  const html = ui.socListHTML();
  assert.ok(html.indexOf('gamma.example') < html.indexOf('alpha.example'));
  assert.ok(html.indexOf('undated.example') > html.indexOf('alpha.example'));
});
