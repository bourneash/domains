'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function routeHarness(hash) {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const stateStart = source.indexOf('const SH = {');
  const stateEnd = source.indexOf('function shBadgeStatus', stateStart);
  const parserStart = source.indexOf('function parseHash()');
  const parserEnd = source.indexOf('function hashFor', parserStart);
  assert.ok(
    stateStart >= 0 && stateEnd > stateStart && parserStart >= 0 && parserEnd > parserStart
  );

  const replaced = [];
  const context = {
    URLSearchParams,
    location: { hash },
    history: { replaceState: (_state, _title, url) => replaced.push(url) },
  };
  vm.runInNewContext(
    `var STATE = { view: 'socialhub' };
     ${source.slice(stateStart, stateEnd)}
     function topViews() { return ['control', 'socialhub']; }
     ${source.slice(parserStart, parserEnd)}
     globalThis.routeApi = { SH, parseHash, shApplyRoute, shSyncRoute };`,
    context
  );
  return { ...context.routeApi, replaced };
}

test('Social Hub fragment filters open the exact Queue slice', () => {
  const harness = routeHarness(
    '#socialhub?tab=queue&status=draft&site=rc-9.com&platform=bluesky&kind=post&q=Easy'
  );

  const route = harness.parseHash();
  assert.equal(route.view, 'socialhub');
  assert.equal(harness.shApplyRoute(route.socialHub), true);
  assert.equal(harness.SH.tab, 'queue');
  assert.equal(harness.SH.status, 'draft');
  assert.equal(harness.SH.site, 'rc-9.com');
  assert.equal(harness.SH.queuePlatform, 'bluesky');
  assert.equal(harness.SH.kind, 'post');
  assert.equal(harness.SH.queueSearch, 'Easy');
});

test('changing Queue filters writes a shareable fragment URL', () => {
  const harness = routeHarness('#socialhub');
  Object.assign(harness.SH, {
    tab: 'queue',
    site: 'alpha.com',
    status: 'posted',
    queuePlatform: 'bluesky',
    kind: 'post',
    queueSearch: 'launch day',
  });

  harness.shSyncRoute();

  assert.equal(
    harness.replaced.at(-1),
    '#socialhub?tab=queue&site=alpha.com&status=posted&platform=bluesky&kind=post&q=launch+day'
  );
});
