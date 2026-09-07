'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCollapseUI(saved = []) {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const start = source.indexOf('/* ---- persisted collapsible panels ---- */');
  const end = source.indexOf('/* ===================== FLEET ===================== */', start);
  assert.ok(start >= 0 && end > start, 'collapsible panel section markers should exist');

  const writes = [];
  const context = vm.createContext({
    document: {},
    localStorage: {
      getItem: () => JSON.stringify(saved),
      setItem: (key, value) => writes.push([key, value]),
    },
    esc: value => String(value ?? ''),
    $: () => null,
    $$: () => [],
    writes,
  });
  vm.runInContext(
    `${source.slice(start, end)}\nglobalThis.collapseUI = { UI_COLLAPSED, collapsiblePanel, wireCollapsiblePanels, writes };`,
    context
  );
  return context.collapseUI;
}

test('collapsible panel renders persisted closed state with accessible controls', () => {
  const ui = loadCollapseUI(['analytics.health']);
  const html = ui.collapsiblePanel(
    'analytics.health',
    'Capture Freshness',
    '<table></table>',
    'dh-panel dh-wide'
  );

  assert.match(html, /class="dh-panel dh-wide ui-collapsible is-collapsed"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /class="ui-collapse-body hidden"/);
  assert.match(html, /id="ui-panel-analytics-health"/);
});

test('collapsible panel renders open by default', () => {
  const ui = loadCollapseUI();
  const html = ui.collapsiblePanel('analytics.pages', 'Top Pages', '<table></table>');

  assert.match(html, /class="dh-panel ui-collapsible"/);
  assert.doesNotMatch(html, /is-collapsed/);
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /ui-collapse-body hidden/);
});

test('analytics view exposes row selection and previous-next site navigation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

  assert.match(source, /class="an-site-row/);
  assert.match(source, /data-step="-1"/);
  assert.match(source, /data-step="1"/);
  assert.match(source, /scrollIntoView\(\{/);
  assert.match(source, /wireCollapsiblePanels\(app\)/);
});
