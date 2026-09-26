'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicDir = path.join(__dirname, 'public');

function routeFor(hash) {
  const source = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = source.indexOf('function topViews()');
  const end = source.indexOf('// FRESH = true', start);
  assert.ok(start >= 0 && end > start);
  const context = { location: { hash }, URLSearchParams };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.result = parseHash();`, context);
  return context.result;
}

test('navigation category roots are first-class routes', () => {
  for (const view of ['agents', 'ops', 'content', 'growth', 'quality']) {
    assert.equal(routeFor(`#${view}`).view, view);
  }
});

test('site command centers are shareable first-class routes', () => {
  const route = routeFor('#site/example.test');
  assert.equal(route.view, 'site');
  assert.equal(route.siteSlug, 'example.test');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function renderSiteDetail\(\)/);
  assert.match(app, /site command center/);
  assert.match(app, /site-console-link/);
});

test('executive leadership is a first-class Agents page', () => {
  assert.equal(routeFor('#agents/executive').view, 'agent');
  assert.equal(routeFor('#agents/executive').agent, 'executive');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /Executive Leadership/);
  assert.match(app, /Fleet Executive Office/);
  assert.match(app, /CEO, CTO, CRO, CFO/);
  assert.match(app, /fleet AI spend telemetry/);
  assert.match(app, /principalQueue,\s+croLabRuns,/);
  assert.match(app, /croLabRuns,\s+runStatus,\s*\]/);
  assert.match(app, /croLabRuns\?\.runs \|\| \[\]/);
  assert.match(app, /id="ex-risk" class="cm-input"/);
  assert.match(app, /Low — conservative/);
  assert.match(app, /class="ex-operating-modes"/);
  assert.match(app, /id="ex-notes" class="cm-input" rows="6"/);
  assert.match(app, /\$\('#ex-open-setup'\)\?\.addEventListener\('click'/);
});

test('product managers are first-class Agents pages with durable queues', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  for (const role of ['product-manager-fleet', 'product-manager-sites']) {
    assert.equal(routeFor(`#agents/${role}`).view, 'agent');
    assert.equal(routeFor(`#agents/${role}`).agent, role);
  }
  assert.match(app, /PRODUCT MANAGEMENT \/ \$\{esc\(role === 'product-manager-fleet'/);
  assert.match(app, /api\/executive\/work-items\?owner=/);
  assert.match(app, /api\/executive\/task-queue\?role=/);
  assert.match(app, /Executive presentations/);
  assert.match(app, /Open work queue/);
});

test('executive workbench is a first-class operator route', () => {
  assert.equal(routeFor('#workbench').view, 'workbench');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /Executive Workbench/);
  assert.match(app, /api\/executive\/work-items/);
  assert.match(app, /wb-thread-toggle/);
});

test('knowledge shelf is a first-class operator route', () => {
  assert.equal(routeFor('#knowledge').view, 'knowledge');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /Knowledge shelf/);
  assert.match(app, /api\/executive\/knowledge/);
  assert.match(app, /kn-learning-save/);
});

test('Git operations and Git Hygiene share one page with distinct tabs', () => {
  assert.equal(routeFor('#git').view, 'git');
  assert.equal(routeFor('#git').gitTab, 'operations');
  assert.equal(routeFor('#git/hygiene').view, 'git');
  assert.equal(routeFor('#git/hygiene').gitTab, 'hygiene');
  assert.equal(routeFor('#githygiene').view, 'git');
  assert.equal(routeFor('#githygiene').gitTab, 'hygiene');
});

test('sidebar category navigation and disclosure use separate controls', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /class="rl-h-main"/);
  assert.match(shell, /class="rl-toggle"/);
  assert.match(
    shell,
    /location\.hash = h\.dataset\.root;\s+toggleSection\(h\.closest\('\.rl-sec'\)\)/
  );
  assert.doesNotMatch(shell, /an active item inside a collapsed section/);
  assert.match(theme, /\.rail-folded \.rl-fold\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*3;/s);
});

test('fleet health pulse exposes an actionable explanation', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /id="fleet-health-trigger"/);
  assert.match(shell, /id="fleet-health-details"/);
  assert.match(shell, /active scheduled roles are fresh/);
  assert.match(shell, /Open Health view/);
  assert.match(shell, /aria-expanded/);
});

test('fleet vitals cards provide destinations and role-health context', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(shell, /data-vt-action="control\?filter=attention"/);
  assert.match(shell, /data-vt-action="containers"/);
  assert.match(shell, /scheduled-role freshness/);
  assert.match(shell, /openVitalView/);
  assert.match(app, /controlFilter/);
  assert.match(app, /CONTROL\.filter === 'fresh'/);
  assert.match(app, /Fresh roles/);
});

test('category cards share the sidebar icon system', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /globalThis\.fleetNavIcon = icon/);
  assert.match(app, /class="nav-root-icon"[^>]*>\$\{.*globalThis\.fleetNavIcon/);
  assert.match(shell, /globalThis\.fleetAgentIcon = agentIcon/);
  assert.match(app, /globalThis\.fleetAgentIcon\(key\)/);
  assert.match(shell, /engineer: '🛠️'/);
});

test('command palette exposes a keyboard and screen-reader friendly listbox', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(shell, /aria-controls="cmdk-list"/);
  assert.match(shell, /role="listbox"/);
  assert.match(shell, /role="option" aria-selected=/);
  assert.match(shell, /aria-activedescendant/);
  assert.match(shell, /restoreFocus/);
  assert.match(index, /id="updated"[^>]*aria-live="polite"/);
  assert.match(index, /id="toast"[^>]*aria-live="polite"/);
});

test('saved views provide a client-side operator snapshot menu', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /SAVED_VIEWS_KEY = 'fd\.saved-views\.v1'/);
  assert.match(shell, /Save current view/);
  assert.match(shell, /data-view-save/);
  assert.match(shell, /location\.hash = view\.hash/);
  assert.match(theme, /\.view-saves-menu/);
});

test('the shell exposes the authenticated access level', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /applyAccessLevel\(a\?\.access\)/);
  assert.match(app, /Read-only/);
  assert.match(theme, /\.access-badge\.is-viewer/);
});

test('agent pages expose enrollment actions that open the automation editor', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /class="btn sm ag-enroll"/);
  assert.match(app, /AUTO_ROLE_DRAFT = \{/);
  assert.match(app, /go\('automation'\)/);
  assert.match(app, /Enrolling \$\{esc\(roleDraft\.role\)\}/);
  assert.match(app, /Sites not enrolled in Engineer/);
  assert.match(app, /Every discovered site is enrolled in Engineer/);
  assert.match(app, /removeRoleEnrollment\(button\.dataset\.site, button\.dataset\.role, button\)/);
  assert.match(app, /Remove \$\{role\} from \$\{site\}/);
  assert.match(app, /rebuilding cron/);
  assert.match(app, /Current health/);
  assert.match(app, /healthy now/);
  assert.match(app, /7d history/);
  assert.doesNotMatch(app, /<details class="card ag-health" open>/);
  assert.match(app, /missed/);
  assert.match(app, /historical failures/);
  assert.match(app, /Current status is shown first/);
  assert.match(app, /Execution history/);
  assert.match(app, /class="btn sm ag-health-details"[^>]*>Expand<\/button>/);
  assert.match(app, /function toggleHealthDetail\(button\)/);
  assert.match(app, /ag-health-detail-grid/);
  assert.match(app, /function fmtDate\(value\)/);
  assert.match(app, /Pause current issues/);
  assert.match(app, /Rerun historical failures/);
});
