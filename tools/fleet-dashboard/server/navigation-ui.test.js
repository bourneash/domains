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

test('agent navigation tolerates both bare-list and enveloped API responses', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function normalizeAgentList\(value\)/);
  assert.match(app, /if \(Array\.isArray\(value\?\.agents\)\) return value\.agents/);
  assert.match(app, /const \[sites, agents\] = await Promise\.all\(\[/);
  assert.match(app, /apiOptional\('GET', '\/api\/agents', \{ agents: \[\] \}\)/);
});

test('optional API reads do not hide authentication failures as empty data', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function apiOptional(');
  const end = app.indexOf('/* ---- auth gate', start);
  assert.ok(start >= 0 && end > start);
  const helper = app.slice(start, end);
  assert.match(helper, /error\?\.message === 'authentication required'/);
  assert.match(helper, /throw error/);
});

test('executive inbox and run history are primary reads, never optional empty fallbacks', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /: api\(\s*'GET',\s*`\/api\/executive\/inbox\?limit=50/);
  assert.match(app, /: api\('GET', '\/api\/executive\/run-status'\)/);
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
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /Executive Leadership/);
  assert.match(app, /Fleet Executive Office/);
  assert.match(app, /CEO, CTO, CRO, CFO/);
  assert.match(app, /fleet AI spend telemetry/);
  assert.match(app, /principalQueue,\s+croLabRuns,/);
  assert.match(app, /croLabRuns,\s+runStatus,\s+cases,/);
  assert.match(app, /else if \(page === 'overview'\) \{\s*hide\(run\);/);
  assert.match(app, /croLabRuns\?\.runs \|\| \[\]/);
  assert.match(app, /id="ex-risk" class="cm-input"/);
  assert.match(app, /Low — conservative/);
  assert.match(app, /class="ex-operating-modes"/);
  assert.match(style, /body\[data-view="agent"\] main:has\(\.ex-shell\) \{ max-width: none; \}/);
  assert.match(
    style,
    /\.ex-workspace-nav \{[^}]*grid-template-columns: repeat\(9, minmax\(0, 1fr\)\)/
  );
  assert.match(app, /id="ex-notes" class="cm-input" rows="6"/);
  assert.match(app, /\$\('#ex-open-setup'\)\?\.addEventListener\('click'/);
  assert.match(app, /optional\('GET', '\/api\/cases\?limit=300'/);
  assert.match(app, /UNIFIED CASE/);
});

test('executive decisions workspace opens its decision history', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf("} else if (page === 'decisions') {");
  const end = app.indexOf("} else if (page === 'signals')", start);
  assert.ok(start >= 0 && end > start);
  const decisionsWorkspace = app.slice(start, end);
  assert.match(decisionsWorkspace, /hide\(layout\)/);
  assert.match(decisionsWorkspace, /show\(decisions\)/);
  assert.match(decisionsWorkspace, /decisions\.open\s*=\s*true/);
  assert.match(app, /optional\('GET', '\/api\/executive\/proposals\?limit=100'/);
  assert.match(app, /optional\('GET', '\/api\/executive\/actions\?limit=200'/);
});

test('executive run logs support focused filtering and wider detail panes', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /ex-run-log-search/);
  assert.match(app, /value="important"/);
  assert.match(app, /Tool pass-through/);
  assert.match(app, /function wireExecutiveRunLogFilters\(detail, shell\)/);
  assert.match(style, /width: min\(1320px, 97vw\)/);
  assert.match(style, /\.ex-run-log-controls/);
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

test('executive conversation workspace behaves like an email inbox', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf("} else if (page === 'conversation') {");
  const end = app.indexOf("} else if (page === 'runs')", start);
  assert.ok(start >= 0 && end > start);
  const workspace = app.slice(start, end);
  assert.match(app, /id="ex-compose"/);
  assert.match(app, /id="ex-message" class="cm-input" rows="5"/);
  assert.match(app, /Start a durable request here/);
  assert.match(workspace, /const split = requests\?\.querySelector\('\.ex-request-split'\)/);
  assert.match(workspace, /requests\.insertBefore\(compose, split\)/);
  assert.match(app, /: null;\n  EXEC_INBOX_UI\.selected = selectedRequestId/);
  assert.match(app, /new Map\(\s*\(inbox\.requests \|\| requests\.work_items \|\| \[\]\)\.map/);
  assert.match(app, /class="ex-request-list-summary"/);
  assert.match(app, /<b>Full thread<\/b>/);
  assert.match(app, /const threadSection =\s*thread\.length > 1/);
  assert.doesNotMatch(app, /ex-request-response/);
  assert.match(app, /api\('POST', '\/api\/executive\/requests', \{ actor: 'owner', body \}\)/);
  assert.match(app, /\$\('#ex-message'\)\.value = ''/);
  assert.match(app, /class="btn sm primary ex-work-reply-send"/);
  assert.match(app, /Reply added; the executive team will see it on its next run/);
});

test('executive conversation route skips unrelated control-plane requests', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /const conversationOnly = STATE\.agentPage === 'conversation'/);
  assert.match(
    app,
    /conversationOnly\s*\? Promise\.resolve\(\{ messages: \[\], retention_days: 90 \}\)/
  );
  assert.match(
    app,
    /conversationOnly\s*\?\s*Promise\.resolve\(\{\s*proposals:\s*\[\]\s*\}\)\s*:\s*dashboardOnly\s*\?\s*Promise\.resolve\(\{ proposals: \[\]\s*\}\)\s*:\s*optional\('GET', '\/api\/executive\/proposals\?limit=100'/
  );
  assert.match(
    app,
    /conversationOnly\s*\?\s*Promise\.resolve\(\{\s*cases:\s*\[\]\s*\}\)\s*:\s*dashboardOnly\s*\?\s*Promise\.resolve\(\{ cases: \[\]\s*\}\)\s*:\s*optional\('GET', '\/api\/cases\?limit=300'/
  );
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

test('sidebar supports persistent favorites and reordering', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /prefs\.favorites/);
  assert.match(shell, /const PREFS_VERSION = 1/);
  assert.match(shell, /normalizePrefs/);
  assert.match(shell, /uniqueFavoriteIds/);
  assert.match(shell, /schemaVersion = PREFS_VERSION/);
  assert.match(shell, /localStorage\.getItem\(LS\)/);
  assert.match(shell, /localStorage\.setItem\(LS, JSON\.stringify\(prefs\)\)/);
  assert.match(shell, /addEventListener\('storage'/);
  assert.match(shell, /event\.newValue == null \? \{\} : JSON\.parse\(event\.newValue\)/);
  assert.match(shell, /const navReady = \['ops', 'content', 'growth', 'quality'\]/);
  assert.match(shell, /if \(!navReady\) return saved/);
  assert.match(shell, /const agentsReady = sourceSecs\.some\(s => s\.id === 'agents'\)/);
  assert.match(shell, /!agentsReady && id\.startsWith\('agent:'\)/);
  assert.match(shell, /if \(valid\.length !== saved\.length\)/);
  assert.match(shell, /prefs\.favorites = valid/);
  assert.match(shell, /data-favorite-toggle/);
  assert.match(shell, /root: { key: id, label:/);
  assert.match(shell, /class="rl-root-fav"/);
  assert.match(shell, /if \(src\.root\) location\.hash = `#\$\{src\.key\}`/);
  assert.match(
    shell,
    /src\.root \? rootView === src\.key : src\.el\.classList\.contains\('active'\)/
  );
  assert.match(shell, /data-favorite-move/);
  assert.match(shell, /data-favorites-clear/);
  assert.match(shell, /Clear favorites/);
  assert.match(shell, /draggable="\$\{isFavorites \? 'true' : 'false'\}"/);
  assert.match(shell, /dataTransfer\.setData\('text\/plain'/);
  assert.match(shell, /restoreFavoriteFocus/);
  assert.match(shell, /target\?\.focus\(\)/);
  assert.match(shell, /globalThis\.fleetToast\?\./);
  assert.match(shell, /aria-posinset="\$\{n \+ 1\}"/);
  assert.match(shell, /aria-setsize="\$\{items\.length\}"/);
  assert.match(shell, /pInput\.setAttribute\('aria-activedescendant', 'cmdk-option-0'\)/);
  assert.match(shell, /function mark\(n\) \{\s*if \(!items\.length\) return;/);
  assert.match(shell, /e\.key === 'Home'/);
  assert.match(shell, /e\.key === 'End'/);
  assert.match(theme, /\.rl-sec\[data-sec="favorites"\]/);
  assert.match(theme, /\.rl-fav-row\.is-drop-target/);
  assert.match(theme, /\.rl-favorites-clear/);
  assert.match(theme, /\.rl-root-fav/);
});

test('shared shell provides reversible focus mode and shareable route links', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /Copy current link/);
  assert.match(shell, /navigator\.clipboard\.writeText\(location\.href\)/);
  assert.match(shell, /document\.execCommand\?\.\('copy'\)/);
  assert.match(shell, /area\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(shell, /fd-focus-mode/);
  assert.match(shell, /e\.key === '\/'/);
  assert.match(shell, /e\.key === '\?'/);
  assert.match(theme, /body\.fd-focus-mode #vitals/);
});

test('shared shell surfaces uncaught UI failures with bounded recovery actions', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /addEventListener\('error'/);
  assert.match(shell, /addEventListener\('unhandledrejection'/);
  assert.match(shell, /data-runtime-reload/);
  assert.match(shell, /slice\(0, 500\)/);
  assert.match(theme, /#fd-runtime-alert/);
  assert.match(theme, /#fd-runtime-alert\[hidden\]/);
});

test('shared shell surfaces browser connectivity changes', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /function installNetworkStatus\(\)/);
  assert.match(shell, /addEventListener\('offline'/);
  assert.match(shell, /addEventListener\('online'/);
  assert.match(shell, /Offline — refresh paused/);
  assert.match(theme, /\.fd-network-status\.is-offline/);
});

test('automatic refresh avoids issuing requests while the browser is offline', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /function refreshTick\(\) \{\s*if \(typeof navigator !== 'undefined' && navigator\.onLine === false\) return;/
  );
});

test('top-level view errors get an in-context retry action', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /globalThis\.fleetRetryView = \(\) =>/);
  assert.match(app, /FRESH = false;/);
  assert.match(shell, /function normalizeErrorRecovery\(root = document\)/);
  assert.match(shell, /\$\$\('\.error-box', root\)/);
  assert.match(shell, /app\?\.contains\(region\)/);
  assert.match(shell, /data-fd-retry/);
  assert.match(shell, /globalThis\.fleetRetryView\(\)/);
  assert.match(theme, /\.fd-error-actions/);
});

test('soft refresh failures preserve the last successful page', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /function renderViewError\(target, message\)/);
  assert.match(app, /if \(!FRESH && target\.firstElementChild\)/);
  assert.match(app, /Showing the last successful data/);
  assert.match(app, /data-fd-stale-retry/);
  assert.match(app, /\$\$\('\.fd-stale-banner'\)\.forEach\(banner => banner\.remove\(\)\)/);
  assert.match(theme, /\.fd-stale-banner/);
});

test('Engineer health actions keep their role binding explicit', () => {
  const source = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = source.indexOf('async function renderEngineers()');
  const end = source.indexOf('// Jump from an engineer row', start);
  assert.ok(start >= 0 && end > start);
  const app = source.slice(start, end);
  assert.match(app, /h\.role \|\| 'engineer'/);
  assert.match(app, /const ah = healthBy\[`\$\{r\.site\}:engineer`\];/);
  assert.doesNotMatch(app, /const ah = healthBy\[r\.site\];/);
  assert.doesNotMatch(app, /h\.role \|\| role/);
  assert.match(app, /class="btn sm ag-health-details"[\s\S]*data-role="engineer"/);
  assert.doesNotMatch(app, /ag-health-details"[^`]*data-role="\$\{esc\(role\)\}"/);
});

test('inline Workbench and Knowledge drafts protect unsaved content', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function inlineDraftSnapshot\(panel\)/);
  assert.match(app, /async function closeInlineDraft\(panel, label\)/);
  assert.match(app, /confirmLabel: 'Discard draft'/);
  assert.match(app, /openInlineDraft\(panel\)/);
  assert.match(app, /closeInlineDraft\(\$\('#wb-new'\), 'workbench case draft'\)/);
  assert.match(app, /closeInlineDraft\(\$\('#kn-new'\), 'knowledge source draft'\)/);
});

test('Cron inline editors protect schedule drafts on cancel', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /openInlineDraft\(row\);/g);
  assert.match(app, /closeInlineDraft\(row, 'cron schedule draft'\)/);
  assert.match(app, /closeInlineDraft\(row, 'cron job draft'\)/);
  assert.match(app, /async function cmCloseEditorSafely\(\)/);
  assert.match(app, /async function cmCloseAddJobSafely\(\)/);
  assert.match(app, /cmCloseEditorSafely\(\);\n      cmCloseAddJobSafely\(\);/);
  assert.match(app, /row\.remove\(\);/);
});

test('shared shell keeps loading state and document title in sync with the active view', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(index, /id="app" aria-busy="false"/);
  assert.match(
    shell,
    /setAttribute\('aria-busy', String\(Boolean\(main\.querySelector\('\.loading'\)\)\)\)/
  );
  assert.match(shell, /document\.title\s*=\s*/);
  assert.match(shell, /Domain Fleet Manager/);
});

test('dynamic action buttons default safely without changing form submits', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function normalizeButtons\(root = document\)/);
  assert.match(shell, /button:not\(\[type\]\)/);
  assert.match(shell, /if \(!button\.closest\('form'\)\) button\.type = 'button'/);
  assert.match(shell, /button\[title\]:not\(\[aria-label\]\)/);
  assert.match(shell, /setAttribute\('aria-label', title\)/);
  assert.match(shell, /normalizeButtons\(\$\('#app'\)\)/);
});

test('dynamic tables receive accessible header semantics without overriding authored scopes', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function normalizeTables\(root = document\)/);
  assert.match(shell, /thead th:not\(\[scope\]\)/);
  assert.match(shell, /setAttribute\('scope', 'col'\)/);
  assert.match(shell, /tbody tr.*querySelector\('th:not\(\[scope\]\)'\)/s);
  assert.match(shell, /setAttribute\('scope', 'row'\)/);
});

test('href-less action links become keyboard-operable controls', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function normalizeActionLinks\(root = document\)/);
  assert.match(shell, /a:not\(\[href\]\)/);
  assert.match(shell, /setAttribute\('role', 'button'\)/);
  assert.match(shell, /link\.tabIndex = 0/);
  assert.match(shell, /e\.key === 'Enter' \|\| e\.key === ' '/);
  assert.match(shell, /normalizeActionLinks\(\$\('#app'\)\)/);
});

test('executive text-entry actions use the shared accessible modal instead of browser prompts', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function requestModalText\(\{/);
  assert.match(app, /id="modal-text-entry"/);
  assert.match(app, /MODAL_TEXT_CANCEL/);
  assert.match(app, /await requestModalText\(/);
  assert.doesNotMatch(app, /window\.prompt\(/);
});

test('clearing Favorites uses the shared confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(app, /function requestModalConfirm\(\{/);
  assert.match(app, /globalThis\.fleetConfirm = requestModalConfirm/);
  assert.match(shell, /globalThis\.fleetConfirm\?\.\(/);
  assert.match(shell, /confirmLabel: 'Clear favorites'/);
  assert.doesNotMatch(shell, /Clear all saved favorites\?'\)/);
});

test('Social Hub destructive actions use the shared confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const social = app.slice(
    app.indexOf('async function shPostAction'),
    app.indexOf('async function renderSocialHub')
  );
  assert.match(social, /globalThis\.fleetConfirm\?\.\(/);
  assert.match(social, /confirmLabel: 'Deny post'/);
  assert.match(social, /confirmLabel: 'Publish now'/);
  assert.match(social, /confirmLabel: 'Cancel post'/);
  assert.doesNotMatch(social, /confirm\(/);
});

test('Dev Sandbox destructive actions use the shared confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const sandbox = [
    app.slice(app.indexOf('async function dsAction'), app.indexOf('function dsToggleTab')),
    app.slice(
      app.indexOf('async function dsStopAll'),
      app.indexOf('async function dsRemoveStopped')
    ),
    app.slice(
      app.indexOf('async function dsRemoveStopped'),
      app.indexOf('async function dsCleanOrphans')
    ),
    app.slice(
      app.indexOf('async function dsCleanOrphans'),
      app.indexOf('async function renderDevSandbox')
    ),
  ].join('\n');
  assert.equal((sandbox.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 3);
  assert.match(app, /confirmLabel: 'Remove sandbox'/);
  assert.match(app, /confirmLabel: 'Stop all'/);
  assert.match(app, /confirmLabel: 'Remove stopped'/);
  assert.match(app, /confirmLabel: 'Clean orphans'/);
  assert.doesNotMatch(sandbox, /confirm\(/);
});

test('container lifecycle actions use the shared confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const containers = app.slice(
    app.indexOf('async function restartAllCrons'),
    app.indexOf('/* ===================== TASKS')
  );
  assert.equal((containers.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 3);
  assert.match(containers, /confirmLabel: 'Restart schedulers'/);
  assert.match(containers, /confirmLabel: 'Stop container'/);
  assert.match(containers, /confirmLabel: 'Rebuild container'/);
  assert.doesNotMatch(containers, /confirm\(/);
});

test('cron, social account, and measurement mutations use shared confirmations', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const cron = app.slice(app.indexOf('async function cmRemoveJob'), app.indexOf('/* ---- run now'));
  const rebuild = app.slice(
    app.indexOf('async function cmDoRebuild'),
    app.indexOf('/* ---- diff viewer')
  );
  const revert = app.slice(
    app.indexOf('async function cmDoRevert'),
    app.indexOf('/* ---- log viewer')
  );
  const social = app.slice(
    app.indexOf("const del = $('#f-soc-delete')"),
    app.indexOf('/* ---- persona editor')
  );
  const queue = app.slice(
    app.indexOf("$$('.cq-override-measurement')"),
    app.indexOf("$$('.cq-cancel')")
  );
  const mutations = [cron, rebuild, revert, social, queue].join('\n');
  assert.equal((mutations.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 5);
  assert.match(mutations, /confirmLabel: 'Remove cron line'/);
  assert.match(mutations, /confirmLabel: 'Rebuild container'/);
  assert.match(mutations, /confirmLabel: 'Revert crontab'/);
  assert.match(mutations, /confirmLabel: 'Delete account'/);
  assert.match(mutations, /confirmLabel: 'Override window'/);
  assert.doesNotMatch(mutations, /\bconfirm\(/);
});

test('site facts and Git destructive actions use the shared confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const mutations = [
    app.slice(app.indexOf('async function sfDeleteManual'), app.indexOf('const gitCls')),
    app.slice(
      app.indexOf('async function deleteGitBranch'),
      app.indexOf('// F5: toggle the per-file diff preview')
    ),
    app.slice(
      app.indexOf('async function dropStashUI'),
      app.indexOf('/* ===================== ROLES')
    ),
  ].join('\n');
  assert.equal((mutations.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 3);
  assert.match(mutations, /confirmLabel: 'Delete fact'/);
  assert.match(mutations, /confirmLabel: 'Delete branch'/);
  assert.match(mutations, /confirmLabel: 'Drop stash'/);
  assert.doesNotMatch(mutations, /\bconfirm\(/);
});

test('Git ignore and fleet sync actions use the shared confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const git = app.slice(
    app.indexOf('async function gitIgnore'),
    app.indexOf('/* ===================== GIT STASHES')
  );
  assert.equal((git.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 3);
  assert.match(git, /confirmLabel: 'Ignore path'/);
  assert.match(git, /confirmLabel: 'Push all sites'/);
  assert.match(git, /confirmLabel: 'Pull all sites'/);
  assert.doesNotMatch(git, /\bconfirm\(/);
});

test('task deletion uses the shared recoverable confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const task = app.slice(
    app.indexOf('async function deleteTask'),
    app.indexOf('let MODAL_FORM_BASELINE')
  );
  assert.match(task, /globalThis\.fleetConfirm\?\.\(/);
  assert.match(task, /confirmLabel: 'Move to trash'/);
  assert.match(task, /recoverable/);
  assert.doesNotMatch(task, /\bconfirm\(/);
});

test('Scheduler actions use the shared text and confirmation modals', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(publicDir, 'scheduler-view.js'), 'utf8');
  assert.match(app, /globalThis\.fleetTextPrompt = requestModalText/);
  assert.match(scheduler, /globalThis\.fleetTextPrompt\?\.\(/);
  assert.match(scheduler, /globalThis\.fleetConfirm\?\.\(/);
  assert.match(scheduler, /confirmLabel: 'Adopt site'/);
  assert.match(scheduler, /confirmLabel: 'Release site'/);
  assert.doesNotMatch(scheduler, /\bprompt\(/);
  assert.doesNotMatch(scheduler, /\bconfirm\(/);
});

test('role enrollment and bulk health actions use the shared confirmation surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const roles = app.slice(
    app.indexOf('async function removeRoleEnrollment'),
    app.indexOf('async function runEngineerNow')
  );
  assert.equal((roles.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 2);
  assert.match(roles, /confirmLabel: 'Remove enrollment'/);
  assert.match(roles, /confirmLabel: `\$\{verb\} sites`/);
  assert.doesNotMatch(roles, /\bconfirm\(/);
});

test('Git Hygiene actions use shared text and confirmation modals', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const hygiene = app.slice(
    app.indexOf('async function renderGitHygiene'),
    app.indexOf('async function renderGit()')
  );
  assert.match(hygiene, /globalThis\.fleetTextPrompt\?\.\(/);
  assert.equal((hygiene.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 3);
  assert.match(hygiene, /confirmLabel: 'Sweep fleet'/);
  assert.match(hygiene, /confirmLabel: 'Apply fleet-wide'/);
  assert.match(hygiene, /confirmLabel: 'Adopt ignore block'/);
  assert.doesNotMatch(hygiene, /\bprompt\(/);
  assert.doesNotMatch(hygiene, /\bconfirm\(/);
});

test('AI Optimizer decisions use shared text and confirmation modals', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const optimizer = app.slice(app.indexOf("$$('[data-aiopt-run]"));
  assert.equal((optimizer.match(/globalThis\.fleetConfirm\?\.\(/g) || []).length, 2);
  assert.equal((optimizer.match(/globalThis\.fleetTextPrompt\?\.\(/g) || []).length, 2);
  assert.match(optimizer, /confirmLabel: 'Run implementer'/);
  assert.match(optimizer, /confirmLabel: 'Resume implementer'/);
  assert.doesNotMatch(optimizer, /\bprompt\(/);
  assert.doesNotMatch(optimizer, /\bconfirm\(/);
});

test('domain lifecycle and improvement workflows use shared modal prompts', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const domain = app.slice(
    app.indexOf('async function domOffboard'),
    app.indexOf('async function domQueue')
  );
  const roles = app.slice(
    app.indexOf('async function bulkToggleRole'),
    app.indexOf('function roleDot')
  );
  const improvements = app.slice(
    app.indexOf('async function renderImprovements'),
    app.indexOf('function cqAge')
  );
  assert.match(domain, /globalThis\.fleetTextPrompt\?\.\(/);
  assert.match(domain, /required: true/);
  assert.doesNotMatch(domain, /\bprompt\(/);
  assert.match(roles, /globalThis\.fleetConfirm\?\.\(/);
  assert.doesNotMatch(roles, /\bconfirm\(/);
  assert.equal((improvements.match(/globalThis\.fleetTextPrompt\?\.\(/g) || []).length, 6);
  assert.doesNotMatch(improvements, /\bprompt\(/);
});

test('dynamic loading and error regions expose announcement semantics', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function normalizeStatusRegions\(root = document\)/);
  assert.match(shell, /\.loading:not\(\[role\]\)/);
  assert.match(shell, /setAttribute\('role', 'status'\)/);
  assert.match(shell, /setAttribute\('aria-live', 'polite'\)/);
  assert.match(shell, /\.error-box:not\(\[role\]\)/);
  assert.match(shell, /setAttribute\('role', 'alert'\)/);
  assert.match(shell, /normalizeStatusRegions\(\$\('#app'\)\)/);
});

test('navigation menus expose expanded state and active routes', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function syncMenuButton\(button\)/);
  assert.match(shell, /setAttribute\('aria-haspopup', 'menu'\)/);
  assert.match(
    shell,
    /setAttribute\('aria-expanded', String\(!menu\.classList\.contains\('hidden'\)\)\)/
  );
  assert.match(shell, /menu\.setAttribute\('role', 'menu'\)/);
  assert.match(shell, /setAttribute\('role', 'menuitem'\)/);
  assert.match(shell, /function syncNavigationCurrent\(\)/);
  assert.match(shell, /setAttribute\('aria-current', 'page'\)/);
});

test('unlabeled dynamic form controls receive conservative accessible names', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function normalizeFormControls\(root = document\)/);
  assert.match(shell, /input, select, textarea/);
  assert.match(shell, /control\.labels\?\.length \|\| control\.closest\('label'\)/);
  assert.match(
    shell,
    /control\.getAttribute\('placeholder'\)\s*\|\|\s*control\.getAttribute\('title'\)/
  );
  assert.match(shell, /setAttribute\('aria-label', name\.trim\(\)\)/);
  assert.match(shell, /normalizeFormControls\(\$\('#app'\)\)/);
});

test('focused interactive rows retain Enter and Space activation', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function normalizeKeyboardActions\(root = document\)/);
  assert.match(
    shell,
    /\[role="button"\]\[tabindex="0"\]:not\(.vt\):not\(.an-site-row\), tr\.err-row\[tabindex="0"\]/
  );
  assert.match(shell, /action\.setAttribute\('role', 'button'\)/);
  assert.match(shell, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(shell, /action\.click\(\)/);
  assert.match(shell, /normalizeKeyboardActions\(\$\('#app'\)\)/);
});

test('table expanders use semantic buttons instead of placeholder links', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="table-link sf-open"/);
  assert.match(app, /class="table-link lint-open"/);
  assert.match(app, /class="table-link dom-open"/);
  assert.doesNotMatch(app, /href="#" class="(?:sf-open|lint-open|dom-open)"/);
  assert.match(theme, /\.table-link \{/);
});

test('fleet filtering reports live match counts', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /\$\('#fleet-filter-count'\)/);
  assert.match(app, /\$\{visible\}\/\$\{rows\.length\} rows/);
  assert.match(app, /matching rows/);
  assert.match(index, /id="fleet-filter-count"[^>]*aria-live="polite"/);
  assert.match(theme, /\.fleet-filter-count/);
  assert.match(app, /ff\.addEventListener\('keydown'/);
  assert.match(app, /e\.key === 'Escape' && ff\.value/);
  assert.match(app, /function clearFleetFilter\(\)/);
  assert.match(index, /id="fleet-filter-clear"/);
});

test('narrow screens get a usable navigation drawer instead of icon-only navigation', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /className = 'mobile-rail-toggle'/);
  assert.match(shell, /mobile-rail-backdrop/);
  assert.match(shell, /aria-controls', 'rail'/);
  assert.match(shell, /mobile-rail-open/);
  assert.match(shell, /rail\.inert = mobileClosed/);
  assert.match(shell, /setAttribute\('aria-hidden', String\(mobileClosed\)\)/);
  assert.match(shell, /previousFocus = document\.activeElement/);
  assert.match(shell, /requestAnimationFrame\(\(\) => target\?\.focus\?\.\(\)\)/);
  assert.match(shell, /addEventListener\('resize', syncInteractivity/);
  assert.match(theme, /body\.has-rail \{ padding-left: 0; \}/);
  assert.match(theme, /body\.mobile-rail-open #rail/);
  assert.match(theme, /body\.mobile-rail-open \{ overflow: hidden; \}/);
});

test('mobile navigation keeps keyboard focus inside the open drawer', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function setupMobileRail\(\)/);
  assert.match(shell, /const focusableRail = \(\) =>/);
  assert.match(shell, /document\.body\.classList\.contains\('mobile-rail-open'\)/);
  assert.match(shell, /e\.shiftKey && document\.activeElement === first/);
  assert.match(shell, /!e\.shiftKey && document\.activeElement === last/);
});

test('mobile command bar preserves context and keeps controls reachable', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /#ctx \{ order: 1; flex: 1 1 0; min-width: 0; overflow: hidden; \}/);
  assert.match(theme, /\.actions #refresh::before \{ content: '↻'/);
  assert.match(theme, /\.actions \.density-toggle::before \{ content: '◐'/);
  assert.match(theme, /\.fleet-filter-wrap \{ order: 3; flex: 1 1 100%;/);
});

test('legacy direct-table cards remain horizontally usable on narrow screens', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /@media \(max-width: 720px\)/);
  assert.match(theme, /\.card:has\(> table\) \{ overflow-x: auto; \}/);
});

test('shared table wrappers keep headers visible while scanning long views', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /\.table-wrap \{[\s\S]*overflow: auto/);
  assert.match(theme, /\.table-wrap \.tbl thead th \{[\s\S]*position: sticky/);
  assert.match(theme, /\.table-wrap \.tbl tbody tr:hover/);
});

test('shared shell provides an accessible back-to-top control for long views', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /id = 'fd-back-top'/);
  assert.match(shell, /scrollY > 420/);
  assert.match(shell, /scrollTo\(\{ top: 0/);
  assert.match(shell, /aria-label', 'Back to top'/);
  assert.match(theme, /#fd-back-top\.is-visible/);
});

test('dashboard includes a keyboard skip link to the current page content', () => {
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(index, /class="skip-link" href="#app"/);
  assert.match(theme, /\.skip-link:focus/);
});

test('operational API failures use the shared recovery surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(publicDir, 'scheduler-view.js'), 'utf8');
  assert.match(app, /renderViewError\(app, `Could not load retention policy: \$\{e\}`\)/);
  assert.match(
    app,
    /renderViewError\(app, `Could not reach \/api\/fleet-doctor: \$\{String\(e\)\}`\)/
  );
  assert.match(app, /renderViewError\(app, `Executive setup failed: \$\{e\.message\}`\)/);
  assert.match(app, /renderViewError\(app, `Executive control plane failed: \$\{e\.message\}`\)/);
  assert.match(app, /renderViewError\(\$\('#auto-body'\), e\.message\)/);
  assert.match(app, /renderViewError\(panel, `Unable to load queue actions: \$\{e\.message\}`\)/);
  assert.match(app, /renderViewError\(app, `Social account registry failed: \$\{e\.message\}`\)/);
  assert.match(app, /renderViewError\(app, `Social Hub proxy failed: \$\{e\.message\}`\)/);
  assert.match(
    app,
    /renderViewError\(\$\('#sh-queue-list'\), `Social queue failed: \$\{e\.message\}`\)/
  );
  assert.match(
    app,
    /renderViewError\(\$\('#sh-calendar-list'\), `Social calendar failed: \$\{e\.message\}`\)/
  );
  assert.match(
    app,
    /renderViewError\(\$\('#sh-inbox-list'\), `Social inbox failed: \$\{e\.message\}`\)/
  );
  assert.match(
    app,
    /renderViewError\(\$\('#sh-channels-list'\), `Social channels failed: \$\{e\.message\}`\)/
  );
  assert.match(
    app,
    /renderViewError\(\$\('#sh-events-list'\), `Social events failed: \$\{e\.message\}`\)/
  );
  assert.match(app, /function shPreviousPanel\(selector, loading\)/);
  assert.match(app, /shPreviousPanel\('#sh-queue-list', 'Loading…'\)/);
  assert.match(app, /shPreviousPanel\('#sh-calendar-list', 'Loading upcoming schedule…'\)/);
  assert.match(app, /renderViewError\(app, `Failed to load stashes: \$\{e\.message\}`\)/);
  assert.match(app, /renderViewError\(content, e\.message\)/);
  assert.match(scheduler, /globalThis\.fleetRenderViewError\(app, message\)/);
  for (const message of [
    'Audit failed:',
    'Git scan failed:',
    'AI usage aggregation failed:',
    'Deploy health failed:',
    'Cron read failed:',
    'Compliance scan failed:',
    'Domains failed:',
  ]) {
    assert.ok(app.includes('renderViewError(app, `' + message + ' ${e.message}`)'));
  }
});

test('page-level failures do not fall back to generic empty markup', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(publicDir, 'scheduler-view.js'), 'utf8');
  assert.doesNotMatch(app, /class="empty"[^>]*(?:failed|Failed|unreachable)/);
  assert.doesNotMatch(scheduler, /class="empty"[^>]*(?:failed|Failed|unreachable)/);
});

test('Work Board keeps one authoritative renderer', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.equal((app.match(/async function renderWorkflowBoard\(\)/g) || []).length, 1);
  assert.doesNotMatch(app, /renderWorkflowBoardLegacy/);
  assert.doesNotMatch(app, /function showWorkflowBacklogFormLegacy/);
  assert.doesNotMatch(app, /function openWorkflowItemLegacy/);
});

test('Work Board filters persist and cannot contradict each other', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /fd\.work-board\.filters/);
  assert.match(app, /localStorage\.setItem\(\s*WORK_BOARD_FILTER_KEY/);
  assert.match(app, /other\.delete\(key\)/);
  assert.match(app, /Filters are remembered on this device/);
});

test('primary API requests fail clearly instead of loading forever', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /const API_TIMEOUT_MS = 60000/);
  assert.match(app, /new AbortController\(\)/);
  assert.match(app, /Request timed out after/);
  assert.match(app, /clearTimeout\(timeout\)/);
});

test('fleet site filtering persists across reloads and clears cleanly', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /localStorage\.getItem\('fd\.fleet-filter'\)/);
  assert.match(app, /localStorage\.setItem\('fd\.fleet-filter', ff\.value\)/);
  assert.match(app, /localStorage\.removeItem\('fd\.fleet-filter'\)/);
  assert.match(app, /function clearFleetFilter\(\)/);
  assert.match(index, /id="fleet-filter-clear"/);
  assert.match(theme, /\.fleet-filter-clear/);
  assert.match(app, /applyFleetFilter\(\);/);
});

test('browser preferences degrade safely when storage is unavailable', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /function autoCfg\(\)[\s\S]*?catch \{\n    return \{ on: true, interval: 15000 \};/
  );
  assert.match(app, /notifications\.filter\([\s\S]*?catch \{\n    unseen = notifications;/);
  assert.match(app, /try \{\n      new Notification\([\s\S]*?\n    \} catch \{\}/);
  assert.match(app, /localStorage\.setItem\('fd\.auto'/);
});

test('form controls retain a visible keyboard focus ring', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /select:focus-visible, input:focus-visible, textarea:focus-visible/);
  assert.match(theme, /outline: 2px solid var\(--a1\)/);
  assert.match(theme, /outline-offset: 2px/);
});

test('AI Optimizer failures use the shared non-blocking notification surface', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const optimizer = app.slice(app.indexOf('async function renderAIOptimizer'), app.length);
  assert.match(optimizer, /toast\(`Run failed: \$\{e\.message\}`, 'err'\)/);
  assert.match(optimizer, /toast\(`Toggle failed: \$\{e\.message\}`, 'err'\)/);
  assert.match(optimizer, /toast\(`Move failed: \$\{e\.message\}`, 'err'\)/);
  assert.doesNotMatch(optimizer, /alert\(/);
});

test('Social Hub post editing stays inside the shared modal workflow', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function openSocialPostEditor\(\{ id, btn, mode \}\)/);
  assert.match(app, /id="sh-editor-body"/);
  assert.match(app, /type="datetime-local"/);
  assert.match(app, /Displayed in your local time and saved as UTC/);
  assert.match(app, /openSocialPostEditor\(\{ id, btn, mode: 'edit' \}\)/);
  assert.match(app, /openSocialPostEditor\(\{ id, btn, mode: 'reschedule' \}\)/);
  assert.match(app, /function openSocialPostFeedback\(\{ id, btn, act \}\)/);
  assert.match(app, /id="sh-feedback-category"/);
  assert.match(app, /id="sh-feedback-reason"/);
  assert.match(app, /openSocialPostFeedback\(\{ id, btn, act \}\)/);
});

test('shared shell manages focus for every modal surface', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(shell, /installModalFocusManager/);
  assert.match(
    shell,
    /\.modal:not\(\.hidden\), \.login-overlay:not\(\.hidden\), \.err-drawer-shell:not\(\.hidden\), \.ex-run-drawer-shell:not\(\.hidden\), #cmdk:not\(\.hidden\)/
  );
  assert.match(shell, /previousFocus = document\.activeElement/);
  assert.match(shell, /e\.key !== 'Tab'/);
  assert.match(shell, /addEventListener\('keydown', e => \{/);
  assert.match(index, /id="modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(index, /id="modal-close"[^>]*aria-label="Close dialog"/);
});

test('executive run logs open in an independent loading drawer', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /async function openExecutiveRunLog\(actionId\)/);
  assert.match(app, /Loading run log…/);
  assert.match(app, /openExecutiveRunLog\(button\.dataset\.id\)/);
  assert.doesNotMatch(app, /EXEC_RUN_UI\.selected = button\.dataset\.id;\s*softRender\(\)/);
  assert.match(style, /\.ex-run-drawer\s*\{/);
  assert.match(style, /\.ex-run-drawer-loading::before/);
});

test('edit modals protect unsaved changes without retaining sensitive fields', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function modalFormSnapshot\(\)/);
  assert.match(app, /\['password', 'file'\]/);
  assert.match(app, /function modalFormIsDirty\(\)/);
  assert.match(app, /Discard unsaved changes\?/);
  assert.match(app, /function closeModal\(force = false\)/);
  assert.match(app, /confirmLabel: 'Discard changes'/);
  assert.doesNotMatch(app, /!confirm\('Discard your unsaved changes\?'/);
  assert.match(app, /const previousBody = body\?\.innerHTML/);
  assert.match(app, /MODAL_FORM_BASELINE = previousBaseline/);
  assert.match(app, /watchModalFormState\(\);/);
  assert.match(app, /closeModal\(true\);/);
});

test('notifications queue rapid results and expose explicit dismissal', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /toast\._queue/);
  assert.match(app, /toast\._queue = toast\._queue\.slice\(-5\)/);
  assert.match(app, /globalThis\.fleetToast = toast/);
  assert.match(shell, /toast-message/);
  assert.match(index, /id="toast-close"/);
  assert.match(theme, /#toast-close/);
});

test('soft refresh snapshots safe form state without retaining credentials', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /let UISNAP = \{ open: \{\}, html: \{\}, details: \[\], fields: \[\]/);
  assert.match(app, /type === 'password' \|\| type === 'file'/);
  assert.match(app, /selectedOptions/);
  assert.match(app, /target\.checked = Boolean\(saved\.checked\)/);
  assert.match(app, /target\.value = saved\.value/);
});

test('command palette harvests the live personalized Favorites section', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /\.rl-sec\[data-sec="favorites"\] \.rl-it/);
  assert.match(shell, /group: 'favorites'/);
  assert.match(shell, /run: \(\) => button\.click\(\)/);
});

test('command palette keeps a bounded, local recent-command history', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /const RECENT_KEY = 'fd\.command-recent\.v1'/);
  assert.match(shell, /function readRecent\(\)/);
  assert.match(shell, /function rememberCommand\(item\)/);
  assert.match(shell, /slice\(0, 8\)/);
  assert.match(shell, /group: 'recent'/);
  assert.match(shell, /recentGroup: item\.group/);
  assert.match(shell, /recentGroup \|\| it\.group/);
  assert.match(shell, /localStorage\.setItem\(RECENT_KEY, JSON\.stringify\(next\)\)/);
});

test('command palette can clear recent commands without re-adding the clear action', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function clearRecentCommands\(\)/);
  assert.match(shell, /label: 'Clear recent commands'/);
  assert.match(shell, /skipRecent: true/);
  assert.match(shell, /if \(!it\.skipRecent\) rememberCommand/);
  assert.match(shell, /localStorage\.removeItem\(RECENT_KEY\)/);
});

test('command palette exposes a clear action for an active site filter', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /label: 'Clear site filter'/);
  assert.match(shell, /\$\('#fleet-filter-clear'\)\?\.click\(\)/);
});

test('every dashboard new-tab link has an opener boundary', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const targets = app.match(/target="_blank"/g) || [];
  const protectedTargets =
    app.match(/target="_blank"[^>]*rel="[^"]*(?:noopener|noreferrer)[^"]*"/g) || [];
  assert.ok(targets.length > 0);
  assert.equal(protectedTargets.length, targets.length);
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

test('keyboard shortcuts are discoverable from the command palette', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /label: 'Keyboard shortcuts'/);
  assert.match(shell, /id = 'fd-shortcuts'/);
  assert.match(shell, /⌘K, \?, or \//);
  assert.match(shell, /#fd-shortcuts:not\(\.hidden\)/);
  assert.match(theme, /#fd-shortcuts \{/);
  assert.match(theme, /\.fd-shortcuts-grid/);
});

test('live version changes never force a document reload', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const checkVersion = app.slice(
    app.indexOf('async function checkVersion()'),
    app.indexOf('async function boot()')
  );
  assert.match(checkVersion, /update-pill.*classList\.remove\('hidden'\)/s);
  assert.doesNotMatch(checkVersion, /location\.reload\(\)/);
  assert.match(app, /#update-pill.*location\.reload\(\)/s);
});

test('the self-update action confirms before reloading the workspace', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /title: 'Reload dashboard\?'/);
  assert.match(app, /Unsaved editor content and the current workspace position may be lost/);
  assert.match(app, /confirmLabel: 'Reload now'/);
  assert.match(app, /if \(approved === false\) return;/);
});

test('route navigation respects dirty modal editors before replacing the view', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function go(view, agent, agentPage)');
  const end = app.indexOf('/* ---- agents dropdown ---- */', start);
  assert.ok(start >= 0 && end > start);
  const go = app.slice(start, end);
  assert.match(go, /if \(!closeModal\(\)\) return false;/);
  assert.match(go, /location\.hash !== `#\$\{hash\}`/);
  assert.match(go, /return true;/);
});

test('saved-view navigation shares the dirty-editor guard', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(app, /globalThis\.fleetBeforeNavigate = \(\) => closeModal\(\)/);
  assert.match(shell, /const approved = await globalThis\.fleetBeforeNavigate\?\.\(\)/);
  assert.match(shell, /if \(approved === false\) return;/);
});

test('saved views provide a client-side operator snapshot menu', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /SAVED_VIEWS_KEY = 'fd\.saved-views\.v1'/);
  assert.match(shell, /Save current view/);
  assert.match(shell, /function openSavedViewEditor\(menu\)/);
  assert.match(shell, /id="view-save-name"/);
  assert.match(shell, /view-save-cancel/);
  assert.match(shell, /data-view-save/);
  assert.match(shell, /location\.hash = view\.hash/);
  assert.match(shell, /Escape.*menu\.classList\.contains\('hidden'\)/s);
  assert.match(shell, /restoreFocus\?\.focus\?\.\(\)/);
  assert.match(theme, /\.view-saves-menu/);
});

test('saved views preserve the Work Board filter context', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /const SAVED_STATE_KEYS = \['fd\.work-board\.filters'\]/);
  assert.match(shell, /function captureSavedState\(\)/);
  assert.match(shell, /function restoreSavedState\(state\)/);
  assert.match(shell, /state: captureSavedState\(\)/);
  assert.match(shell, /restoreSavedState\(view\.state\)/);
  assert.match(shell, /board filters/);
});

test('saved-view deletion uses the shared confirmation surface', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /menu\.addEventListener\('click', async e =>/);
  assert.match(shell, /title: 'Delete saved view\?'/);
  assert.match(shell, /confirmLabel: 'Delete view'/);
  assert.match(shell, /approved === false/);
});

test('saved views expose keyboard-navigable menu semantics', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /view-save-open" role="menuitem"/);
  assert.match(shell, /view-save-delete" role="menuitem"/);
  assert.match(shell, /view-save-new" role="menuitem"/);
  assert.match(shell, /menu\.addEventListener\('keydown', e =>/);
  assert.match(shell, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
  assert.match(shell, /items\[next\]\?\.focus\(\)/);
});

test('the shell exposes the authenticated access level', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /applyAccessLevel\(a\?\.access\)/);
  assert.match(app, /Read-only/);
  assert.match(theme, /\.access-badge\.is-viewer/);
});

test('light theme is wired into the shell and shared route surfaces', () => {
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(index, /id="theme-toggle"/);
  assert.match(index, /localStorage\.getItem\('fd\.theme'\)/);
  assert.match(app, /function applyThemeUI\(\)/);
  assert.match(app, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(theme, /:root\[data-theme="light"\] \.ex-kpi/);
  assert.match(theme, /:root\[data-theme="light"\] \.sh-tile/);
  assert.match(theme, /:root\[data-theme="light"\] \.seg-btn\.active/);
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
