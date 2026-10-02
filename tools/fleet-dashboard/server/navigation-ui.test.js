'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicDir = path.join(__dirname, 'public');

test('light-mode secondary and danger button hover states keep legible ink', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.btn:hover:not\(\.primary\)\s*\{[^}]*color:\s*var\(--text-hi\)[^}]*background-color:\s*var\(--control-bg-hover\)/
  );
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.btn\.danger:hover\s*\{[^}]*color:\s*var\(--red\)/
  );
});

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

test('agent labels retain standard executive and product acronyms', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function agentLabel(role)');
  const end = app.indexOf('// The agents endpoint', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(
    `${app.slice(start, end)}\nglobalThis.labels = ['ceo','cfo','cro','cto','seo-analyst','ai-optimizer'].map(agentLabel);`,
    context
  );
  assert.deepEqual(Array.from(context.labels), [
    'CEO',
    'CFO',
    'CRO',
    'CTO',
    'SEO Analyst',
    'AI Optimizer',
  ]);
});

test('agent navigation omits unavailable site counts instead of rendering undefined', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function buildAgentsMenu()');
  const end = app.indexOf('function syncAgentsMenuActive()', start);
  assert.ok(start >= 0 && end > start);
  const menu = { innerHTML: '' };
  const context = {
    STATE: {
      agents: [
        { role: 'ceo', label: 'CEO' },
        { role: 'engineer', label: 'Engineer', sites: 4 },
        { role: 'delivery-lead', label: 'Delivery Lead', scope: 'fleet' },
      ],
    },
    $: () => menu,
    $$: () => [],
    esc: value => String(value),
    agentLabel: role => role,
    syncAgentsMenuActive() {},
    globalThis: {},
  };
  vm.runInNewContext(`${app.slice(start, end)}\nbuildAgentsMenu();`, context);
  assert.doesNotMatch(menu.innerHTML, />undefined</);
  assert.match(menu.innerHTML, /data-role="ceo"><span>CEO<\/span><\/a>/);
  assert.match(
    menu.innerHTML,
    /data-role="engineer"><span>Engineer<\/span><span class="dd-count">4<\/span>/
  );
  assert.match(
    menu.innerHTML,
    /data-role="delivery-lead"><span>Delivery Lead<\/span><span class="dd-count">fleet queue<\/span>/
  );
});

test('Agents landing cards omit repeated filler when site coverage is unavailable', () => {
  const appSource = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = appSource.indexOf('function renderCategoryRoot(id)');
  const end = appSource.indexOf('\nfunction renderAgent(role)', start);
  assert.ok(start >= 0 && end > start);
  const app = { innerHTML: '' };
  const context = {
    STATE: {
      agents: [
        { role: 'ceo', label: 'CEO' },
        { role: 'engineer', label: 'Engineer', sites: 4 },
      ],
    },
    $: () => app,
    $$: () => [],
    esc: value => String(value),
    agentLabel: role => role,
    stamp() {},
    globalThis: {},
  };
  vm.runInNewContext(`${appSource.slice(start, end)}\nrenderCategoryRoot('agents');`, context);
  assert.doesNotMatch(app.innerHTML, /undefined/);
  assert.doesNotMatch(app.innerHTML, /Automated role available across the fleet/);
  assert.match(app.innerHTML, /4 sites run this agent/);
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

test('executive inbox and run history are bounded and disclose degraded telemetry', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /optional\(\s*'GET',\s*`\/api\/executive\/inbox\?limit=50/);
  assert.match(app, /optional\(\s*'GET',\s*'\/api\/executive\/run-status'/);
  assert.match(app, /degraded: true/);
  assert.match(app, /Some executive telemetry is taking longer than expected/);
  assert.match(app, /routeIs\('executive'\) \|\| routeIs\('agent', 'executive', requestedPage\)/);
});

test('site command centers are shareable first-class routes', () => {
  const route = routeFor('#site/example.test');
  assert.equal(route.view, 'site');
  assert.equal(route.siteSlug, 'example.test');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function renderSiteDetail\(\)/);
  assert.match(app, /site command center/);
  assert.match(app, /site-console-link/);
  assert.match(app, /<dt>Last ship<\/dt>/);
  assert.doesNotMatch(app, /<dt>Cloudflare<\/dt>/);
  const siteStart = app.indexOf('function renderSiteDetail()');
  const siteEnd = app.indexOf('function renderSiteDetail', siteStart + 1);
  const siteView = app.slice(siteStart, siteEnd > siteStart ? siteEnd : siteStart + 20000);
  assert.ok((siteView.match(/class="table-wrap"><table/g) || []).length >= 2);
});

test('site command deep links retain domain context in the shell title', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /rootView === 'site'/);
  assert.match(shell, /location\.hash\.match/);
  assert.match(shell, /const rawSite =/);
  assert.match(shell, /<span class="ctx-g">Domain Control<\/span>/);
  assert.match(shell, /document\.title = `\$\{siteLabel\} · Domain Fleet Manager`/);
});

test('site command deep links retain Domain Control navigation state', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /const navigationView = rootView === 'site' \? 'control' : rootView/);
  assert.match(shell, /item\.dataset\.view === navigationView/);
});

test('async agent pages abandon stale route responses', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function routeIs\(view, agent = undefined, agentPage = undefined\)/);
  assert.match(app, /if \(!routeIs\('agent', 'engineer', null\)\) return;/);
  assert.match(app, /if \(!routeIs\('agent', requestedRole, null\)\) return;/);
  assert.match(app, /const executiveRouteActive = \(\) =>/);
  assert.match(app, /if \(!executiveRouteActive\(\)\) return;/);
});

test('shared API reads abandon stale route responses before renderers continue', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /let ROUTE_EPOCH = 0;/);
  assert.match(app, /class StaleRouteError extends Error/);
  assert.match(app, /const requestEpoch = ROUTE_EPOCH;/);
  assert.match(app, /if \(requestEpoch !== ROUTE_EPOCH\) throw new StaleRouteError\(\);/);
  assert.match(app, /error\?\.name === 'StaleRouteError'/);
  assert.match(app, /message instanceof StaleRouteError/);
  assert.match(app, /message\.includes\('route changed while data was loading'\)/);
});

test('async route renders surface failures without unhandled promise rejections', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /function renderRoute\(\)[\s\S]*Promise\.resolve\(pending\)\.catch\(error => \{/
  );
  assert.match(app, /renderViewError\(\$\('#app'\), error\)/);
  assert.doesNotMatch(app, /window\.addEventListener\('hashchange',[\s\S]*?\n\s*render\(\);/);
});

test('stale route renders retry the current route after a rapid return', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /renderEpoch !== ROUTE_EPOCH/);
  assert.match(app, /renderRoute\.retryEpoch !== ROUTE_EPOCH/);
  assert.match(app, /queueMicrotask\(\(\) => \{[\s\S]*renderRoute\(\);/);
});

test('dynamic form controls receive stable fallback names', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /function normalizeFormControls\(root = document\)/);
  assert.match(shell, /if \(!control\.id && !control\.name\)/);
  assert.match(shell, /control\.name = `fd-\$\{slug \|\| 'field'\}-\$\{fallbackIndex\+\+\}`/);
});

test('legacy scheduler restart accessible name includes its visible action', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /id="restart-crons" aria-label="Restart legacy schedulers"[^>]*>↻ Restart legacy schedulers/
  );
});

test('compact buttons retain a minimum touch-target height', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /\.btn\.sm \{ min-height: 26px;/);
});

test('navigation branding stays readable when the rail is constrained', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    shell,
    /class="rl-brand" title="Domain Fleet Manager" aria-label="Domain Fleet Manager home"/
  );
  assert.match(shell, /class="rl-word" title="Domain Fleet Manager">Fleet Manager<\/span>/);
  assert.match(theme, /\.rl-word \{[\s\S]*text-overflow: ellipsis/);
});

test('shared dark theme primitives meet readable contrast targets', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /\.btn\.primary \{[\s\S]*background: #286fb9/);
  assert.match(theme, /th \{[\s\S]*color: var\(--muted\)/);
  assert.match(theme, /\.vt-scope \{[\s\S]*color: var\(--muted\)/);
});

test('light theme table headers keep the same contrast contract', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(theme, /:root\[data-theme="light"\][\s\S]*?--muted:\s+#5b6981;/);
  assert.match(
    theme,
    /:root\[data-theme="light"\] th \{[\s\S]*background: var\(--panel-2\);[\s\S]*color: #53627c;/
  );
  assert.match(
    style,
    /\.ag-enrollment-gap \.ag-missing-toggle \{[\s\S]*background: var\(--control-bg\);/
  );
  assert.match(theme, /:root\[data-theme="light"\] \.b-gray \{[^}]*color: #59677f/);
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.priority-pagination \.muted \{ color: #59677f; \}/
  );
  assert.match(theme, /:root\[data-theme="light"\] \.seg-btn\.active \.ctl-n \{ color: #174f92/);
  assert.match(theme, /:root\[data-theme="light"\] \.seg-btn \{ color: #59677f; \}/);
});

test('compact executive workspace tabs retain their full context', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /class="ex-workspace-tab \$\{active === key \? 'active' : ''\}"[\s\S]*title="\$\{esc\(`\$\{label\}: \$\{description\}`\)\}"/
  );
  assert.match(app, /aria-label="\$\{esc\(`\$\{label\}: \$\{description\}`\)\}"/);
});

test('fleet vitals ignore stale route-scoped container responses', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /const requestId = \(loadVitals\.requestId \|\| 0\) \+ 1/);
  assert.match(shell, /if \(requestId !== loadVitals\.requestId\) return;/);
  assert.match(shell, /const socialScoped = document\.body\.dataset\.view === 'socialhub'/);
});

test('initial route loading reserves the first viewport to prevent layout shift', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    theme,
    /#app:has\(\.loading\) \{[\s\S]*min-height: min\(640px, calc\(100vh - 170px\)\)/
  );
});

test('initial vitals loading reserves the rail geometry to prevent layout shift', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /rail\.className = 'vitals-pending'/);
  assert.match(shell, /rail\.classList\.remove\('hidden', 'vitals-pending'\)/);
  assert.match(
    theme,
    /#vitals\.vitals-pending \{[\s\S]*visibility: hidden;[\s\S]*pointer-events: none;/
  );
});

test('initial topbar renders shell controls before hydration', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /<body class="has-rail">/);
  for (const marker of [
    'cmdk-hint',
    'focus-mode-toggle',
    'view-saves',
    'fd-network-status',
    'access-badge',
  ]) {
    assert.match(html, new RegExp(`class="[^"]*${marker}`));
  }
  assert.match(html, /aria-label="⌘ K — Open command palette"/);
  for (const script of ['scheduler-view.js', 'app.js', 'shell.js'])
    assert.match(html, new RegExp(`<script src="${script}" defer><\\/script>`));
  assert.ok(html.indexOf('scheduler-view.js') < html.indexOf('app.js'));
  assert.ok(html.indexOf('app.js') < html.indexOf('shell.js'));
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /\.fd-network-status\[hidden\] \{ display: none; \}/);
});

test('private dashboard publishes valid non-indexing metadata', () => {
  const robots = fs.readFileSync(path.join(publicDir, 'robots.txt'), 'utf8');
  const llms = fs.readFileSync(path.join(publicDir, 'llms.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*\nDisallow: \/\s*$/);
  assert.match(llms, /^# Domain Fleet Manager/m);
  assert.match(llms, /private and requires operator authentication/i);
  assert.match(llms, /- \[Domain Fleet Manager\]\(\/\):/);
});

test('Executive deep links retain their operating workspace context', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /rootView === 'executive'/);
  assert.match(shell, /specialContext\.group/);
  assert.match(shell, /specialContext\.label/);
});

test('agent deep links retain role context in the shell title', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /rootView === 'agent'/);
  assert.match(shell, /location\.hash\.match\(\/\^#agents/);
  assert.match(shell, /label\.replace\(\/\[-_\]\+\/g, ' '\)/);
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
  assert.match(app, /type="button" class="btn" id="pm-refresh"/);
  assert.match(app, /\$\('#pm-refresh'\)\.onclick = \(\) => renderProductManager\(role\)/);
});

test('Exec Overwatch exposes a self-contained refresh action', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const route = app.slice(
    app.indexOf('async function renderExecOverwatch'),
    app.indexOf(
      '/* ===================== PRODUCT MANAGER PAGE',
      app.indexOf('async function renderExecOverwatch')
    )
  );
  assert.match(route, /type="button" class="btn" id="overwatch-refresh"/);
  assert.match(route, /\$\('#overwatch-refresh'\)\.onclick = \(\) => renderExecOverwatch\(\)/);
  assert.match(route, /type="button" class="btn primary" id="overwatch-run"/);
  assert.match(route, /type="button" class="btn [^\"]+" id="overwatch-toggle"/);
});

test('executive workbench is a first-class operator route', () => {
  assert.equal(routeFor('#workbench').view, 'workbench');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /Executive Workbench/);
  assert.match(app, /api\/executive\/work-items/);
  assert.match(app, /wb-thread-toggle/);
  assert.match(app, /aria-label="Open thread for \${esc\(item\.title\)}"/);
  assert.match(app, /aria-controls="wb-thread-\${esc\(item\.work_id\)}"/);
  assert.match(app, /button\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(app, /button\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(app, /type="button" class="btn" id="wb-refresh"/);
  assert.match(app, /\$\('#wb-refresh'\)\.onclick = \(\) => renderWorkbench\(\)/);
  assert.match(app, /id="wb-search" class="cm-input" type="search"/);
  assert.match(
    app,
    /const WORKBENCH_STATUSES = \['open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled'\]/
  );
  assert.match(
    app,
    /<details class="wb-status-filter" id="wb-filter-status"><summary aria-label="Filter workbench cases by status">/
  );
  assert.match(app, /class="wb-status-options" role="group" aria-label="Workbench statuses"/);
  assert.match(
    app,
    /WORKBENCH_UI\.status = \$\$\('input\[type="checkbox"\]', \$\('#wb-filter-status'\)\)[\s\S]*?\.filter\(input => input\.checked\)/
  );
  assert.match(app, /aria-label="Search workbench cases"/);
  assert.match(app, /searchable\.includes\(query\)/);
  assert.match(app, /const wbGroups = new Map\(\)/);
  assert.match(
    app,
    /const allCaseThreads = \[\.\.\.allGroups\.values\(\)\]\.map\(wbRepresentative\)/
  );
  assert.match(app, /const active = allCaseThreads\.filter/);
  assert.match(app, /const count = status => allCaseThreads\.filter/);
  assert.match(app, /wbCollapsedRecords/);
  assert.match(app, /linked records/);
  assert.match(app, /duplicate set/);
  assert.match(app, /aria-label="Workbench case pages"/);
  assert.match(app, /Workbench cases per page/);
  assert.match(
    app,
    /pageSize: window\.matchMedia\?\.\('\(max-width: 700px\)'\)\.matches \? 10 : 25/
  );
  assert.match(app, /Showing \$\{pageStart \+ 1\}/);
  assert.match(app, /WORKBENCH_UI\.page = 1/);
  assert.match(app, /Add owner direction to this case/);
});

test('executive overview gives dense controls explicit context', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /aria-label="Filter executive runs"/);
  assert.match(app, /aria-label="Filter executive runs by status"/);
  assert.match(app, /caption class="sr-only">Executive run history<\/caption>/);
  assert.match(app, /caption class="sr-only">Executive calendar events<\/caption>/);
  assert.match(app, /aria-label="Search executive cases"/);
  assert.match(app, /aria-label="Filter executive requests"/);
  assert.match(app, /aria-label="Sort run history by \$\{label\}"/);
});

test('workbench thread expansion exposes an accessible loading state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /thread\.innerHTML\s*=\s*'<div class="async-loading" role="status" aria-live="polite">Loading thread…<\/div>'/
  );
});

test('change and Workbench detail timelines stay bounded on narrow screens', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.ok(
    (app.match(/<h4>Timeline<\/h4><div class="table-wrap"><table class="tbl">/g) || []).length >= 2
  );
});

test('Change Queue mobile hero does not inherit a desktop flex height', () => {
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    style,
    /@media \(max-width: 650px\) \{[\s\S]*?\.cq-page-head > div:first-child \{ flex: 0 1 auto; width: 100%; \}/
  );
});

test('Work Board mobile hero does not inherit a desktop flex height', () => {
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    style,
    /@media \(max-width: 700px\) \{[\s\S]*?\.wb-head > div:first-child \{ flex: 0 1 auto; width: 100%; \}/
  );
});

test('Site Command Center mobile hero does not inherit a desktop flex height', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    theme,
    /@media \(max-width: 820px\) \{[\s\S]*?\.site-command-head > div:first-child \{ flex: 0 1 auto; width: 100%; \}/
  );
});

test('Data Quality keeps its source table bounded on narrow screens', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /role="status" aria-live="polite"><div class="loading">Checking data contracts…<\/div>/
  );
  assert.match(
    app,
    /page-title">Data Quality[\s\S]*class="seo-stats dq-stats"[\s\S]*class="card dq-contracts"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare coverage, freshness, and error details<\/div><div class="table-wrap" tabindex="0" role="region" aria-label="Data quality contract status"><table class="tbl">/
  );
  assert.match(app, /aria-label="Contract health summary"/);
  assert.match(app, /id="dataquality-refresh"/);
  assert.match(app, /\$\('#dataquality-refresh'\)\.onclick = \(\) => renderDataQuality\(\)/);
  assert.match(app, /No data quality contracts have been recorded yet/);
  assert.match(app, /caption class="sr-only">Data quality contract status<\/caption>/);
});

test('Retention exposes a primary loading state before reading policy data', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /async function renderRetention\(\)[\s\S]*?class="loading">Loading retention policy…<\/div>/
  );
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
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /Knowledge shelf/);
  assert.match(app, /api\/executive\/knowledge/);
  assert.match(app, /return api\('GET', '\/api\/executive\/knowledge\?limit=300'\)/);
  assert.match(
    app,
    /\.catch\(e => \{\s+if \(isStaleRouteError\(e\)\) throw e;\s+renderViewError\(app, `Knowledge shelf failed to load:/
  );
  assert.match(app, /kn-learning-save/);
  assert.match(app, /id="kn-search" class="cm-input" type="search"/);
  assert.match(app, /Search knowledge sources/);
  assert.match(app, /aria-label="Add learning note for \${esc\(item\.title\)}"/);
  assert.match(app, /button\.setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(app, /type="button" class="btn" id="kn-refresh"/);
  assert.match(app, /\$\('#kn-refresh'\)\.onclick = \(\) => renderKnowledge\(\)/);
  assert.doesNotMatch(app, /Publisher not recorded|No relevance note recorded\./);
  assert.match(app, /class="kn-data-quality">Catalog gaps:/);
  assert.match(
    theme,
    /@media \(max-width: 700px\)[\s\S]*\.kn-list \{ grid-template-columns: minmax\(0, 1fr\); \}/
  );
  assert.match(theme, /\.kn-card \{ min-width: 0; \}/);
  assert.match(theme, /\.kn-foot \{ flex-wrap: wrap; \}/);
});

test('executive overview gives repeated operational actions row context', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /aria-label="Dismiss notification: \$\{esc\(notification\.title\)\}"/);
  assert.match(app, /aria-label="View log for \$\{esc\(label\.toLowerCase\(\)\)\} run/);
  assert.match(app, /aria-label="Clear failed \$\{esc\(label\.toLowerCase\(\)\)\} run/);
  assert.match(app, /aria-label="Pick up calendar event: \$\{esc\(e\.title\)\}"/);
  assert.match(app, /aria-label="Approve proposal: \$\{esc\(p\.title\)\}"/);
});

test('Git operations and Git Hygiene share one page with distinct tabs', () => {
  assert.equal(routeFor('#git').view, 'git');
  assert.equal(routeFor('#git').gitTab, 'operations');
  assert.equal(routeFor('#git/hygiene').view, 'git');
  assert.equal(routeFor('#git/hygiene').gitTab, 'hygiene');
  assert.equal(routeFor('#githygiene').view, 'git');
  assert.equal(routeFor('#githygiene').gitTab, 'hygiene');
});

test('disabled Git sync actions retain their visible action in the explanation', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /disabled title="Pull all unavailable — nothing to pull"/);
  assert.match(app, /disabled title="Push all unavailable — nothing to push"/);
  assert.match(app, /disabled title="Push unavailable — nothing to push"/);
  assert.match(app, /disabled title="Pull unavailable — nothing to pull"/);
});

test('Git repository rows are keyboard-operable disclosures', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /class="git-row"[\s\S]*role="button" tabindex="0" aria-expanded="false"/);
  assert.match(app, /<span class="sr-only">Open repository details<\/span><\/td>\s*<\/tr>/);
  assert.match(
    app,
    /class="table-wrap" tabindex="0" role="region" aria-label="Fleet repository status"/
  );
  assert.match(app, /Swipe horizontally to compare branch, working-tree, and remote status/);
  assert.match(app, /aria-expanded="false" aria-controls="gd-\$\{esc\(r\.slug\)\}"/);
  assert.match(app, /\['Enter', ' '\]\.includes\(e\.key\)/);
  assert.match(app, /trigger\?\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(app, /trigger\?\.setAttribute\('aria-expanded', 'false'\)/);
});

test('Task cards and fleet rows are keyboard-operable editors', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /class="task \$\{t\.blocked_on \? 'task-blocked' : ''\}"[\s\S]*role="button" tabindex="0"\s*>\s*<span class="sr-only">Open task: <\/span>/
  );
  assert.match(
    app,
    /class="tree-task \$\{t\.blocked_on \? 'task-blocked' : ''\}"[\s\S]*role="button" tabindex="0"\s*>\s*<span class="sr-only">Open task: <\/span>/
  );
  assert.match(
    app,
    /class="ttr \$\{t\.blocked_on \? 'task-blocked' : ''\}"[\s\S]*role="button" tabindex="0"\s*>\s*<td><span class="sr-only">Open task: <\/span>/
  );
  assert.match(
    app,
    /\$\$\('\.tree-task, \.ttr'\)\.forEach\(el =>\n    el\.addEventListener\('keydown'/
  );
});

test('Domain Control role cells are keyboard-operable status disclosures', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /class="rdot r-\$\{c\.state\}"[\s\S]*role="button" tabindex="0" aria-label="Open/
  );
  assert.match(app, /\$\$\('\.rdot\[data-site\]'\)\.forEach\(d => \{/);
  assert.match(app, /aria-label="\$\{anyEnabled \? 'Pause' : 'Resume'\} \$\{esc\(r\)\} on all/);
  assert.match(app, /<caption class="sr-only">Fleet role coverage matrix<\/caption>/);
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

test('initial sidebar build skips a redundant zero-scroll layout flush', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(shell, /const scroll = nav\.scrollTop/);
  assert.match(shell, /if \(scroll > 0\) nav\.scrollTop = scroll/);
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
    /src\.root[\s\S]{0,100}\? navigationView === src\.key[\s\S]{0,100}: src\.el\.classList\.contains\('active'\)/
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
  assert.match(
    app,
    /\$\$\('\[data-fd-stale-transient\]'\)\.forEach\(banner => banner\.remove\(\)\)/
  );
  assert.match(app, /banner\.dataset\.fdStaleTransient = 'true'/);
  assert.match(app, /target\.querySelector\('\[data-fd-stale-transient\]'\)\?\.remove\(\)/);
  assert.match(theme, /\.fd-stale-banner/);
});

test('shell refresh status distinguishes fresh, refreshing, stale, and unavailable data', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /updated\.dataset\.state = 'fresh'/);
  assert.match(app, /updated\.dataset\.state = FRESH \? 'error' : 'stale'/);
  assert.match(app, /\$\('#updated'\)\?\.setAttribute\('data-state', 'refreshing'\)/);
  assert.match(theme, /#updated\[data-state="fresh"\]/);
  assert.match(theme, /#updated\[data-state="refreshing"\]/);
  assert.match(theme, /#updated\[data-state="stale"\]/);
  assert.match(theme, /#updated\[data-state="error"\]/);
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
  assert.match(app, /type="button" class="btn" id="engineer-refresh"/);
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
  assert.match(index, /id="app" aria-busy="true"/);
  assert.match(
    shell,
    /setAttribute\('aria-busy', String\(Boolean\(main\.querySelector\('\.loading'\)\)\)\)/
  );
  assert.match(shell, /document\.title\s*=\s*/);
  assert.match(shell, /Domain Fleet Manager/);
});

test('desktop command bar keeps theme controls on the primary action row', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /\.actions \{\n  gap: 8px;/);
  assert.match(
    theme,
    /#updated \{\n  display: inline-flex; align-items: center; gap: 6px; min-width: 112px;/
  );
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

test('Social Hub overview bounds platform engagement tables', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function shRenderOverview(data)');
  const end = app.indexOf('function shRenderOversight(data)', start);
  assert.ok(start >= 0 && end > start);
  const overview = app.slice(start, end);
  assert.match(overview, /class="card sh-table-wrap"><table class="tbl"/);
  assert.match(overview, /Social platform engagement over the selected period/);
});

test('Social Hub overview filters expose state and contextual queue jumps', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function shRenderOverview(data)');
  const end = app.indexOf('function shRenderOversight(data)', start);
  const overview = app.slice(start, end);
  assert.match(overview, /aria-pressed="\$\{filter === k\}"/);
  assert.match(
    overview,
    /aria-label="\$\{esc\(label\)\} \$\{n\}\. Filter sites by \$\{esc\(label\)\}"/
  );
  assert.match(overview, />\$\{esc\(label\)\} <span class="ctl-n">\$\{n\}<\/span>/);
  assert.match(overview, /role="group" aria-label="Filter sites by social state"/);
  assert.match(overview, /<span class="sr-only">Open queue filtered to \$\{esc\(label\)\}<\/span>/);
});

test('Social Hub channel register explains its wide mobile layout', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const start = app.indexOf('async function shRenderChannels()');
  const end = app.indexOf('async function shRenderEvents()', start);
  const channels = app.slice(start, end);
  assert.match(channels, /Filter social channels by site/);
  assert.match(channels, /Social channel readiness register/);
  assert.match(channels, /Swipe horizontally to inspect readiness, credentials, and actions/);
  assert.match(style, /\.sh-scroll-hint \{ display: none; \}/);
});

test('Social Hub exposes local refresh and accessible initial loading state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const route = app.slice(
    app.indexOf('async function renderSocialHub'),
    app.indexOf('function shComposerModal')
  );
  assert.match(route, /id="sh-refresh"/);
  assert.match(route, /type="button" id="sh-refresh"/);
  assert.match(route, /<h2 class="page-title">Social publishing<\/h2>/);
  assert.match(route, /Reading the social hub…/);
  assert.match(route, /role="status" aria-live="polite"/);
  assert.match(
    route,
    /\$\('#sh-refresh'\)\.addEventListener\('click', \(\) => renderSocialHub\(\)\)/
  );
  assert.match(route, /role="tablist" aria-label="Social Hub sections"/);
  assert.match(route, /class="seg sh-tabs"[^>]*role="tablist"/);
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    style,
    /@media \(max-width: 560px\) \{\s*\.seg\.sh-tabs \{ display: flex; width: 100%; flex-wrap: wrap; overflow: visible; \}/
  );
  assert.match(route, /role="tab" aria-controls="sh-body" aria-selected=/);
  assert.match(
    route,
    /id="sh-body" role="tabpanel" tabindex="0" aria-labelledby="sh-tab-\$\{SH\.tab\}"/
  );
  assert.match(app, /body\.setAttribute\('aria-labelledby', activeTab\.id\)/);
});

test('Social Hub calendar exits loading flex and keeps mobile day columns readable', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('async function shRenderCalendar()');
  const end = app.indexOf('function shMentionBadge', start);
  assert.ok(start >= 0 && end > start);
  const calendar = app.slice(start, end);
  assert.match(calendar, /list\.classList\.remove\('loading'\);\s+list\.innerHTML/);
  assert.match(calendar, /class="matrix-scroll-hint sh-calendar-scroll-hint" role="note"/);
  assert.match(
    calendar,
    /class="sh-calendar-wrap" tabindex="0" role="region" aria-label="Upcoming posts by day"/
  );
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    style,
    /@media \(max-width: 720px\)[\s\S]*\.sh-calendar-wrap \{ scroll-snap-type: x proximity; \}/
  );
  assert.match(
    style,
    /\.sh-calendar-grid \{ grid-template-columns: repeat\(var\(--sh-calendar-days\), 260px\); width: max-content; min-width: 100%;/
  );
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
  assert.match(
    scheduler,
    /class="table-wrap" tabindex="0" role="region" aria-label="Scheduled jobs and controls"><table class="tbl"/
  );
  assert.match(scheduler, /aria-label="Scheduler sites and adoption status"/);
  assert.match(scheduler, /aria-label="Recent scheduler runs"/);
  assert.equal(
    (scheduler.match(/class="matrix-scroll-hint" role="note">Swipe horizontally to/g) || []).length,
    3
  );
  assert.match(scheduler, /<div class="page-head"><h1 class="sr-only">Scheduler<\/h1>/);
  assert.match(scheduler, /class="sch-run" data-id="\$\{r\.id\}" role="button" tabindex="0"/);
  assert.match(scheduler, /root\.addEventListener\('keydown'/);
  assert.match(scheduler, /type="button" class="btn sm" id="sch-pause"/);
  assert.match(scheduler, /role="status" aria-live="polite">Reading scheduler/);
  assert.match(scheduler, /runRow\.setAttribute\('aria-expanded', String\(SCH\.openRun === id\)\)/);
  assert.match(scheduler, /aria-label="Run \$\{esc\(j\.name\)\} for \$\{esc\(j\.site\)\}"/);
  assert.match(
    scheduler,
    /aria-label="Edit schedule for \$\{esc\(j\.name\)\} on \$\{esc\(j\.site\)\}"/
  );
  assert.match(scheduler, /class="sch-run" data-id="\$\{r\.id\}" role="button" tabindex="0"/);
  assert.match(scheduler, /<span class="sr-only">Open run details<\/span><\/td><\/tr>/);
  assert.match(scheduler, /<label class="sr-only" for="sch-text">Filter jobs<\/label>/);
  assert.match(scheduler, /role="tablist" aria-label="Scheduler scope"/);
  assert.match(scheduler, /role="tab" class="btn sm/);
  assert.match(scheduler, /role="tabpanel" aria-labelledby=/);
  assert.match(scheduler, /role="group" aria-label="Scheduler job views"/);
  assert.match(scheduler, /\[\s*'attention',\s*`Needs attention/);
  assert.match(scheduler, /aria-pressed="\$\{SCH\.jobState === key\}"/);
  assert.match(scheduler, /function schJobState\(job\)/);
  assert.match(scheduler, /<caption class="sr-only">Scheduled jobs and controls<\/caption>/);
  assert.doesNotMatch(scheduler, /\bprompt\(/);
  assert.doesNotMatch(scheduler, /\bconfirm\(/);
});

test('Scheduler prioritizes incidents and bounds both large registers', () => {
  const scheduler = fs.readFileSync(path.join(publicDir, 'scheduler-view.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(scheduler, /attention: 0, running: 1, healthy: 2, disabled: 3/);
  assert.match(
    scheduler,
    /const pageJobs = shown\.slice\(jobPageStart, jobPageStart \+ SCH\.pageSize\)/
  );
  assert.match(
    scheduler,
    /const pageRuns = runs\.slice\(runPageStart, runPageStart \+ SCH\.runPageSize\)/
  );
  assert.match(scheduler, /aria-label="Scheduled job pages"/);
  assert.match(scheduler, /aria-label="Recent run pages"/);
  assert.match(
    scheduler,
    /pageSize: window\.matchMedia\?\.\('\(max-width: 700px\)'\)\.matches \? 10 : 25/
  );
  assert.match(
    scheduler,
    /runPageSize: window\.matchMedia\?\.\('\(max-width: 700px\)'\)\.matches \? 10 : 25/
  );
  assert.match(scheduler, /aria-label="Scheduled jobs per page"/);
  assert.match(scheduler, /aria-label="Scheduler runs per page"/);
  assert.match(theme, /\.sch-pagination \{[^}]*display: flex/);
});

test('Cron log source switcher exposes complete tab semantics', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(app, /role="tab" aria-controls="cm-log-out" aria-selected=/);
  assert.match(app, /b\.setAttribute\('aria-selected', String\(active\)\)/);
  assert.match(app, /out\.setAttribute\('aria-labelledby', activeButton\.id\)/);
  assert.match(index, /id="cm-log-out" class="cn-logs-box" role="tabpanel" tabindex="0"/);
});

test('Change Queue and Guides use shared loading announcements', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /class="loading" role="status" aria-live="polite">Loading change queue/);
  assert.match(app, /cq-detail-card"><div class="loading" role="status" aria-live="polite">/);
  assert.match(app, /id="guide-content" aria-live="polite" aria-busy="true"/);
  assert.match(app, /content\.setAttribute\('aria-busy', 'false'\)/);
});

test('segmented operator filters expose pressed state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /data-ctl-filter="\$\{k\}" aria-pressed="\$\{CONTROL\.filter === k\}"/);
  assert.match(app, /data-ctl-sort="name" aria-pressed="\$\{CONTROL\.sort === 'name'\}"/);
  assert.match(app, /id="v-tree" aria-pressed="\$\{TASK\.view === 'tree'\}"/);
  assert.match(app, /data-group="\$\{group\}" data-val="\$\{esc\(val\)\}" aria-pressed="\$\{on\}"/);
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
  assert.match(app, /<strong>Recommendation queue<\/strong>/);
  assert.doesNotMatch(app, /<strong>AI Optimizer<\/strong>/);
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
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(shell, /function normalizeKeyboardActions\(root = document\)/);
  assert.match(
    shell,
    /\[role="button"\]\[tabindex="0"\]:not\(.vt\):not\(.an-site-row\), tr\.err-row\[tabindex="0"\]/
  );
  assert.match(shell, /action\.setAttribute\('role', 'button'\)/);
  assert.match(shell, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(shell, /action\.click\(\)/);
  assert.match(shell, /normalizeKeyboardActions\(\$\('#app'\)\)/);
  assert.match(
    app,
    /class="err-row"[^>]*role="button" tabindex="0" title="Click to view retained logs"/
  );
});

test('error log drawer supports focus return and async announcements', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /aria-describedby="err-drawer-subtitle"/);
  assert.match(app, /id="err-drawer-status" class="sr-only" role="status" aria-live="polite"/);
  assert.match(app, /ERROR_DRAWER_RETURN_FOCUS = active instanceof HTMLElement \? active : null/);
  assert.match(app, /returnFocus\?\.isConnected && !returnFocus\.closest\('\.hidden'\)/);
  assert.match(app, /log\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /status\.textContent = 'Retained logs loaded'/);
  assert.match(app, /\$\('#err-drawer-close', shell\)\?\.focus\(\)/);
});

test('executive run drawer keeps the same keyboard and live-region contract', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /let EXEC_RUN_LOG_RETURN_FOCUS = null/);
  assert.match(app, /aria-describedby="ex-run-drawer-status"/);
  assert.match(app, /id="ex-run-drawer-status" role="status" aria-live="polite"/);
  assert.match(app, /id="ex-run-drawer-close" class="icon-btn"/);
  assert.match(app, /EXEC_RUN_LOG_RETURN_FOCUS = active instanceof HTMLElement \? active : null/);
  assert.match(app, /if \(event\.key === 'Escape'\) closeExecutiveRunLog\(\)/);
  assert.match(app, /returnFocus\?\.isConnected && !returnFocus\.closest\('\.hidden'\)/);
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

test('Domains route separates command queueing from operational inventory', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    app,
    /role="status" aria-live="polite"><div class="loading">Loading domains…<\/div>/
  );
  assert.match(app, /class="dom-summary" aria-label="Domain operations summary"/);
  assert.match(app, /<span>Recent jobs<\/span>/);
  assert.match(app, /\$\{jobs\.length\} recent<\/span>/);
  assert.match(app, /type="button" class="btn" id="domains-refresh"/);
  assert.match(
    app,
    /\$\('#domains-refresh'\)\.addEventListener\('click', \(\) => renderDomains\(\)\)/
  );
  assert.match(app, /class="dom-command-form" role="group" aria-label="Queue domain command"/);
  assert.match(app, /class="dom-help"><summary>Command safety and scope/);
  assert.match(
    app,
    /aria-label="\$\{open \? 'Close' : 'Open'\} \$\{esc\(j\.command\)\} job details for \$\{esc\(j\.domain\)\}"/
  );
  assert.match(
    app,
    /aria-label="Cancel queued \$\{esc\(j\.command\)\} job for \$\{esc\(j\.domain\)\}"/
  );
  assert.match(app, /aria-label="Check status for \$\{esc\(s\.slug\)\}"/);
  assert.match(app, /aria-label="Offboard \$\{esc\(s\.slug\)\}"/);
  assert.match(app, /caption class="sr-only">Domain command job history<\/caption>/);
  assert.match(app, /caption class="sr-only">Onboarded domains and available actions<\/caption>/);
  assert.match(app, /trigger\?\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(app, /class="dom-panel-head"><div><h3>Job history<\/h3>/);
  assert.match(app, /class="dom-panel-head"><div><h3>Onboarded sites<\/h3>/);
  assert.match(theme, /\.dom-command-form \{[^}]*grid-template-columns/);
  assert.match(theme, /\.dom-stat-bad/);
});

test('dense filter selects expose route-specific accessible names', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /id="seo-priority" class="cm-input" aria-label="Filter SEO opportunities by priority"/
  );
  assert.match(app, /id="seo-type" class="cm-input" aria-label="Filter SEO opportunities by type"/);
  assert.match(app, /id="seo-site" class="cm-input" aria-label="Filter SEO opportunities by site"/);
  assert.match(app, /id="gr-repo-select" aria-label="Repository to override"/);
  assert.match(app, /id="gr-repo-list" aria-label="Guardrail list to edit"/);
  assert.match(
    app,
    /data-soc-category="\$\{esc\(s\.site\)\}" aria-label="Social account category for/
  );
  assert.match(
    app,
    /\$\('#backlink-site'\)\?\.setAttribute\('aria-label', 'Filter backlink coverage by site'\)/
  );
});

test('Social account registry exposes a local refresh control', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const route = app.slice(
    app.indexOf('async function renderSocial()'),
    app.indexOf('function socRenderBody')
  );
  assert.match(route, /type="button" class="btn" id="social-refresh"/);
  assert.match(
    route,
    /\$\('#social-refresh'\)\.addEventListener\('click', \(\) => renderSocial\(\)\)/
  );
});

test('fleet filtering reports live match counts', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /\$\('#fleet-filter-count'\)/);
  assert.match(app, /\$\{visible\}\/\$\{rows\.length\} rows/);
  assert.match(app, /matching rows/);
  assert.match(index, /id="fleet-filter-count"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(
    index,
    /<meta name="description" content="Operational command center for domain health/
  );
  assert.match(
    index,
    /id="update-pill"[^>]*aria-label="↻ Update ready — new dashboard version available"/
  );
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
  assert.match(
    theme,
    /body\.mobile-rail-open \.rl-word \{ display: block; opacity: 1; width: auto; \}/
  );
  assert.match(
    theme,
    /body\.mobile-rail-open \.rl-t,[\s\S]*body\.mobile-rail-open \.rl-n \{ display: initial; \}/
  );
  assert.match(
    theme,
    /body\.mobile-rail-open\.rail-folded \.rl-it \{ justify-content: flex-start;/
  );
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
  assert.match(
    theme,
    /@media \(max-width: 720px\) \{[\s\S]*#vitals-content \{\s*display: grid; grid-template-columns: repeat\(6, 168px\); grid-template-rows: auto auto;/
  );
  assert.match(
    theme,
    /\.vt-scope \{ grid-column: 1 \/ -1; width: max-content; white-space: nowrap;/
  );
  assert.match(theme, /:root\[data-theme="light"\] \{[\s\S]*--a1:\s+#1f65b5;/);
  assert.match(theme, /\.vt \{ flex: 0 0 168px; min-width: 168px; \}/);
  assert.match(
    theme,
    /\.actions \{\s*gap: 8px; min-width: 0; max-width: 100%; box-sizing: border-box;\s*flex-wrap: wrap; justify-content: flex-end;/
  );
  assert.match(
    theme,
    /@media \(max-width: 1400px\) \{[\s\S]*\.actions \{ flex: 0 1 calc\(100% - 44px\); width: calc\(100% - 44px\); \}/
  );
  assert.match(
    theme,
    /@media \(min-width: 721px\) and \(max-width: 1400px\) \{[\s\S]*body\.has-rail \.actions/
  );
  assert.match(theme, /#ctx \{ order: 1; flex: 1 1 120px; min-width: 0; overflow: hidden; \}/);
  assert.match(theme, /\.actions #refresh::before \{ content: '↻'/);
  assert.match(theme, /\.actions \.density-toggle::before \{ content: '◐'/);
  assert.match(theme, /\.fleet-filter-wrap \{ order: 3; flex: 1 1 100%;/);
  assert.match(theme, /\.mobile-rail-toggle \{ display: grid; order: 0; \}/);
  assert.match(theme, /\.mobile-rail-backdrop \{ display: block; \}/);
  assert.match(
    theme,
    /\.actions \{ order: 2; flex: 1 1 260px; min-width: 0; gap: 6px; max-width: 100%; overflow: visible; flex-wrap: wrap;/
  );
  assert.match(
    theme,
    /@media \(max-width: 560px\) \{[\s\S]*#vitals-content \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*overflow-x: visible;/
  );
  assert.match(theme, /@media \(max-width: 560px\) \{[\s\S]*\.vt \{ min-width: 0; width: auto;/);
});

test('mobile task filters stack cleanly without horizontal page overflow', () => {
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    style,
    /@media \(max-width: 560px\) \{[\s\S]*\.filter-row \{ flex-direction: column; gap: 6px; \}/
  );
  assert.match(style, /\.filter-label \{ width: auto; padding-top: 0; \}/);
  assert.match(style, /\.pill-group \{ width: 100%; \}/);
  assert.match(style, /\.seg \{ max-width: 100%; overflow-x: auto; scrollbar-width: thin; \}/);
});

test('shared route headers keep context readable beside actions on narrow screens', () => {
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(style, /\.page-head > div:first-child \{ flex: 1 1 320px; min-width: 0; \}/);
  assert.match(
    style,
    /\.page-head > \.page-title \+ \.muted,[\s\S]*flex: 1 1 320px; min-width: 0;/
  );
  assert.match(style, /\.page-head > \.btn \{ flex: 0 0 auto; margin-left: auto;/);
  assert.match(
    style,
    /@media \(max-width: 620px\) \{[\s\S]*\.page-head > \.btn \{ margin-left: 0; \}/
  );
});

test('legacy direct-table cards remain horizontally usable on narrow screens', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /@media \(max-width: 720px\)/);
  assert.match(theme, /\.card:has\(> table\) \{ overflow-x: auto; \}/);
});

test('Analytics provides route context, local refresh, and accessible loading state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const route = app.slice(
    app.indexOf('async function renderAnalytics'),
    app.indexOf('/* ===================== LINT', app.indexOf('async function renderAnalytics'))
  );
  assert.match(route, /class="page-title">Analytics<\/h2>/);
  assert.match(route, /type="button" class="btn" id="analytics-refresh"/);
  assert.match(route, /Loading analytics…/);
  assert.match(route, /role="status" aria-live="polite"/);
  assert.match(
    route,
    /\$\('#analytics-refresh'\)\.addEventListener\('click', \(\) => renderAnalytics\(\)\)/
  );
  assert.match(route, /Analytics capture freshness by site/);
  assert.match(
    route,
    /No GA4 data for this site\. Choose another site above, or review Capture Freshness\./
  );
  assert.match(route, /Top pages by sessions/);
  assert.match(route, /Affiliate click origin pages/);
  assert.match(route, /Top search queries by clicks/);
});

test('Analytics remembers the operator-selected site across page reloads', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('const ANALYTICS_SITE_KEY =');
  const end = app.indexOf('\n\nlet SEO_PRIORITY', start);
  assert.ok(start >= 0 && end > start);
  const state = app.slice(start, end);
  const values = new Map([['fd.analytics.site.v1', '0xroulette.com']]);
  const result = JSON.parse(
    vm.runInNewContext(
      `${state}\nsetAnalyticsSite('marineactivity.com'); JSON.stringify({site: ANALYTICS_SITE, stored: localStorage.getItem(ANALYTICS_SITE_KEY)})`,
      {
        localStorage: {
          getItem: key => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, String(value)),
          removeItem: key => values.delete(key),
        },
      }
    )
  );
  assert.deepEqual(result, { site: 'marineactivity.com', stored: 'marineactivity.com' });
});

test('Analytics freshness matrix is collapsed only for a first-time preference state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('const UI_COLLAPSE_KEY =');
  const end = app.indexOf('\n\nfunction uiSaveCollapsed', start);
  assert.ok(start >= 0 && end > start);
  const initializer = app.slice(start, end);
  const collapsedFor = saved =>
    JSON.parse(
      vm.runInNewContext(`${initializer}\nJSON.stringify([...UI_COLLAPSED])`, {
        localStorage: { getItem: () => saved },
      })
    );
  assert.deepEqual(collapsedFor(null), ['analytics.health']);
  assert.deepEqual(collapsedFor('["analytics.amazon"]'), ['analytics.amazon']);
});

test('shared table wrappers keep headers visible while scanning long views', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /\.table-wrap \{[\s\S]*overflow: auto/);
  assert.match(theme, /\.table-wrap thead th \{[\s\S]*position: sticky/);
  assert.match(theme, /\.table-wrap tbody tr:hover/);
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

test('Build Usage exposes a scoped refresh control', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /type="button" class="btn" id="cfb-refresh"/);
  assert.match(
    app,
    /\$\('#cfb-refresh'\)\.addEventListener\('click', \(\) => renderCloudflareBuilds\(\{ force: true \}\)\)/
  );
  assert.match(app, /Repository build usage/);
  assert.match(app, /Recent builds and commits/);
  assert.match(app, /Live Cloudflare build triggers/);
  assert.match(app, /const CF_BUILDS = \{\s+days: 7,\s+pageSize: 10,\s+pages:/);
  assert.match(app, /data-cfb-page="\$\{key\}"/);
  assert.match(app, /fleetQuery[\s\S]{0,180}rows\.filter/);
  assert.match(app, /CF_BUILDS\.cache\?\.days === CF_BUILDS\.days/);
  assert.match(app, /matching records across Build Usage registers/);
  assert.match(app, /if \(STATE\.view === 'builds'\) \{\s+CF_BUILDS\.filter = '';/);
});

test('Retention presents policy posture before editable rows', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="retention-summary" aria-label="Retention policy summary"/);
  assert.match(app, /type="button" class="btn" id="retention-refresh"/);
  assert.match(app, /class="retention-toolbar" role="group" aria-label="Retention policy actions"/);
  assert.match(app, /class="retention-days" type="number"/);
  assert.match(app, /class="retention-help"><summary>How the policy is applied/);
  assert.match(
    app,
    /class="matrix-scroll-hint" role="note">Swipe horizontally to review retention classes and policy details/
  );
  assert.match(
    app,
    /role="region" aria-label="Retention policy by data class"><table class="rmatrix">\s*<caption class="sr-only">Retention policy by data class/
  );
  assert.match(theme, /\.retention-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.retention-stat-warn/);
});

test('Doctor presents sweep posture before failure details', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    app,
    /role="status" aria-live="polite"><div class="loading">Loading fleet doctor\\u2026<\/div>/
  );
  assert.match(app, /type="button" class="btn" id="doctor-refresh"/);
  assert.match(app, /class="doctor-summary" aria-label="Fleet doctor summary"/);
  assert.match(app, /class="doctor-toolbar" role="group" aria-label="Fleet doctor actions"/);
  assert.match(app, /class="doctor-result doctor-result-invalid"/);
  assert.match(app, /class="doctor-help"><summary>What this sweep checks/);
  assert.match(theme, /\.doctor-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.doctor-stat-bad/);
});

test('Parked inventory presents renewal exposure before the domain table', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="parked-summary" aria-label="Parked inventory summary"/);
  assert.match(app, /class="parked-toolbar" role="group" aria-label="Parked inventory context"/);
  assert.match(app, /class="parked-help"><summary>How parked age and renewal are calculated/);
  assert.match(theme, /\.parked-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.parked-stat-bad/);
});

test('Scheduler surfaces sites needing adoption before already adopted sites', () => {
  const scheduler = fs.readFileSync(path.join(publicDir, 'scheduler-view.js'), 'utf8');
  const start = scheduler.indexOf('function schSiteOrder(sites)');
  const end = scheduler.indexOf('\nasync function renderScheduler()', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(`${scheduler.slice(start, end)}\nglobalThis.order = schSiteOrder;`, context);
  const sites = [
    { site: 'z-adopted.test', adopted: true },
    { site: 'b-legacy.test', adopted: false },
    { site: 'a-legacy.test', adopted: false },
  ];
  const ordered = context.order(sites);
  assert.deepEqual(
    Array.from(ordered, site => site.site),
    ['a-legacy.test', 'b-legacy.test', 'z-adopted.test']
  );
  assert.deepEqual(
    Array.from(sites, site => site.site),
    ['z-adopted.test', 'b-legacy.test', 'a-legacy.test']
  );
  assert.match(scheduler, /const sites = schSiteOrder\(st\.sites \|\| \[\]\)/);
});

test('Priorities scorecard disclosure separates its title and supporting label', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    app,
    /<details class="card priority-scorecard"><summary><strong>Portfolio allocation scorecard/
  );
  assert.match(theme, /\.priority-scorecard > summary \{[^}]*flex-wrap:\s*wrap/);
  assert.match(theme, /\.priority-scorecard > summary::before \{[^}]*content:\s*'›'/);
  assert.match(theme, /.priority-scorecard\[open\] > summary::before/);
});

test('Git Hygiene keeps actions and long review tables bounded', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="gh-toolbar" role="group" aria-label="Git hygiene actions"/);
  assert.match(app, /class="gh-help"><summary>What the “Always…” decisions do/);
  assert.match(app, /class="card gh-panel"><h2>Review queue/);
  assert.match(theme, /\.gh-toolbar \{[^}]*flex-wrap/);
  assert.match(theme, /\.gh-panel \{[^}]*overflow: hidden/);
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
  assert.match(app, /<span>approval gates<\/span>/);
  assert.match(app, /<span>blocked<\/span>/);
  assert.match(app, /type="button" class="btn" id="wb-board-refresh"/);
  assert.match(
    app,
    /data-wb-include="\$\{key\}" aria-label="Show only \$\{esc\(label\)\}" aria-pressed="\$\{WORK_BOARD_INCLUDE\.has\(key\)\}"/
  );
  assert.match(
    app,
    /data-wb-exclude="\$\{key\}" aria-label="Hide \$\{esc\(label\)\}" aria-pressed="\$\{WORK_BOARD_EXCLUDE\.has\(key\)\}"/
  );
  assert.match(app, /id="wb-board-search" class="cm-input" type="search"/);
  assert.match(app, /aria-label="Search work board items"/);
  assert.match(app, /const WORK_BOARD_PAGE_SIZE = 20/);
  assert.match(app, /function renderWorkflowBoardLane\(key, label, items, total\)/);
  assert.match(app, /aria-label="\$\{esc\(label\)\} work items pages"/);
  assert.match(app, /data-wb-page="\$\{key\}"/);
  assert.match(app, /\$\$\('\[data-wb-page\]'\)/);
  assert.match(app, /WORK_BOARD_PAGES\[key\] = 1/);
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(style, /\.wb-lane-pagination \{/);
  assert.match(style, /\.wb-column \{ min-width: 0;/);
  assert.match(style, /\.wb-board \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(app, /\.includes\(query\)/);
  assert.match(app, /aria-label="Open \$\{esc\(item\.title\)\} details"/);
  assert.match(app, /const diagnosticGroups = \[\]/);
  assert.match(app, /diagnosticIndex\.get\(key\)/);
  assert.match(app, /\$\{item\.count\} matches/);
  assert.match(app, /\$\('#wb-board-refresh'\)\.onclick = \(\) => renderWorkflowBoard\(\)/);
  assert.doesNotMatch(app, /<span>in progress<\/span>/);
});

test('Work Board reduces mobile page length and keeps lane pagination in reach', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const start = app.indexOf('function currentWorkBoardPageSize()');
  const end = app.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const viewport = { matches: false };
  const pageSize = vm.runInNewContext(`${app.slice(start, end)}; currentWorkBoardPageSize`, {
    WORK_BOARD_PAGE_SIZE: 20,
    WORK_BOARD_MOBILE_PAGE_SIZE: 6,
    window: { matchMedia: () => viewport },
  });
  assert.equal(pageSize(), 20);
  viewport.matches = true;
  assert.equal(pageSize(), 6);
  assert.match(app, /const pageSize = currentWorkBoardPageSize\(\)/);
  assert.match(
    style,
    /@media \(max-width: 720px\) \{\s*\.wb-board \{ overflow: visible; \}\s*\.wb-lane-pagination \{\s*position: sticky;\s*bottom: 60px;/
  );
});

test('Work Board filters persist and cannot contradict each other', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /fd\.work-board\.filters/);
  assert.match(app, /localStorage\.setItem\(\s*WORK_BOARD_FILTER_KEY/);
  assert.match(app, /other\.delete\(key\)/);
  assert.match(app, /Filters are remembered on this device/);
});

test('Change Queue renders one authoritative queue pulse without suppressed focus markup', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /cq-overview-grid cq-overview-grid--single/);
  assert.doesNotMatch(app, /cq-focus-panel/);
  assert.doesNotMatch(app, /priorityLane/);
  assert.doesNotMatch(app, /\.cq-focus-panel\'\)\?\.remove/);
  assert.match(app, /aria-label="Open actions for \$\{title\}"/);
  assert.match(app, /aria-label="View work for \$\{esc\(r\.title\)\}"/);
});

test('Change Queue register controls expose explicit accessible context', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /const cqAccessibleLabels = \{/);
  assert.match(app, /'cq-search': 'Search change requests'/);
  assert.match(app, /'cq-status': 'Filter change requests by state'/);
  assert.match(app, /'cq-sort': 'Sort change requests'/);
  assert.match(app, /'cq-page-size': 'Change queue rows per page'/);
  assert.match(app, /Pause automatic dispatch/);
  assert.match(
    app,
    /\$\{CHANGE_QUEUE_SORT_DIR === 'asc' \? 'Ascending' : 'Descending'\} — sort change requests/
  );
  assert.match(app, /aria-label="Dispatch due work — dispatch all due change requests"/);
  assert.match(app, /caption\.className = 'sr-only'/);
  assert.match(app, /caption\.textContent = 'Change request work register'/);
  assert.match(app, /const cqTableWrap = cqTable\?\.closest\('\.table-wrap'\)/);
  assert.match(
    app,
    /cqTableWrap\.setAttribute\([\s\S]*?'aria-label',[\s\S]*?caption\?\.textContent/
  );
  assert.match(app, /Swipe horizontally to review change requests and available actions/);
});

test('AI Usage chart zoom supports touch and pointer cancellation', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /addEventListener\(\s*['"]pointerdown['"]/);
  assert.match(app, /addEventListener\(\s*['"]pointermove['"]/);
  assert.match(app, /addEventListener\(\s*['"]pointerup['"]/);
  assert.match(app, /addEventListener\(\s*['"]pointercancel['"]/);
  assert.match(style, /\.aiu-chart-wrap \{[^}]*touch-action:\s*pan-y/);
});

test('AI Usage presents key metrics as a non-duplicated KPI strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /class="aiu-summary"/);
  assert.match(app, /Tracked spend<\/span>/);
  assert.match(app, /Sites instrumented<\/span>/);
  assert.match(app, /type="button" class="btn" id="aiu-refresh"/);
  assert.match(style, /\.aiu-summary \{[^}]*grid-template-columns/);
});

test('AI Usage period rows show compact UTC labels with machine-readable timestamps', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function aiuPeriodTime(value, bucket)');
  const end = app.indexOf('\n}\n\n// Hover-help', start) + 2;
  assert.ok(start >= 0 && end > start);
  const formatter = vm.runInNewContext(`${app.slice(start, end)}; aiuPeriodTime`, {
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
  });
  assert.equal(
    formatter('2026-09-26T08:00:00Z', 'hour'),
    '<time datetime="2026-09-26T08:00:00.000Z">Sep 26, 08:00 UTC</time>'
  );
  assert.equal(
    formatter('2026-09-26', 'day'),
    '<time datetime="2026-09-26T00:00:00.000Z">Sep 26, 2026 UTC</time>'
  );
  assert.match(app, /aiuPeriodTime\(r\[bucket\], bucket\)/);
});

test('AI Usage chart spaces ticks and includes dates across multiple days', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function usageChart(rows, bucket)');
  const end = app.indexOf('\n}\n\n// Click-and-drag zoom', start) + 2;
  assert.ok(start >= 0 && end > start);
  const render = vm.runInNewContext(`${app.slice(start, end)}; usageChart`, {
    AIU_CHART_GEOM: { width: 760, height: 190, left: 44, bottom: 28, top: 12 },
    esc: value => String(value),
    fmtUSD: value => `$${value}`,
    fmtTokens: value => String(value),
  });
  const hourly = Array.from({ length: 132 }, (_, index) => ({
    hour: new Date(Date.UTC(2026, 8, 26) + index * 60 * 60 * 1000)
      .toISOString()
      .replace('.000', ''),
    total_cost_usd: (index % 4) + 1,
    calls: 1,
    input_tokens: 10,
    output_tokens: 20,
  }));
  const hourlyChart = render(hourly, 'hour');
  const tickCount = (hourlyChart.match(/class="aiu-chart-label"/g) || []).length;
  assert.equal(tickCount, 6);
  assert.match(hourlyChart, />09\/26 00:00<\/text>/);
  assert.match(hourlyChart, />10\/01 11:00<\/text>/);
  const dailyChart = render(
    hourly.slice(0, 7).map((row, index) => ({
      day: row.hour.slice(0, 10),
      total_cost_usd: index + 1,
      calls: 1,
      input_tokens: 10,
      output_tokens: 20,
    })),
    'day'
  );
  assert.equal((dailyChart.match(/class="aiu-chart-label"/g) || []).length, 7);
  assert.match(dailyChart, />09\/26<\/text>/);
});

test('Health presents fleet status as a responsive summary strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /class="health-summary"/);
  assert.match(app, /Sites needing attention<\/span>/);
  assert.match(app, /Failing checks<\/span>/);
  assert.match(app, /class="health-card-head"/);
  assert.match(app, /class="inline-help-link" href="http:\/\/127\.0\.0\.1:8580"/);
  assert.match(app, /Failing health checks/);
  assert.match(app, /class="health-help"><summary>How site health is measured/);
  assert.match(app, /type="button" class="btn" id="health-refresh"/);
  assert.match(
    app,
    /\$\('#health-refresh'\)\.addEventListener\('click', \(\) => renderHealth\(\)\)/
  );
  assert.match(style, /\.health-summary \{[^}]*grid-template-columns/);
  assert.match(style, /\.health-card-head \{[^}]*justify-content/);
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /a\.inline-help-link \{[^}]*text-decoration: underline/);
});

test('Health puts the sites with the most failing checks first', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function healthSiteOrder(order, sites)');
  const end = app.indexOf('\n}\n\nasync function renderHealth', start) + 2;
  assert.ok(start >= 0 && end > start);
  const sortSites = vm.runInNewContext(`${app.slice(start, end)}; healthSiteOrder`);
  const order = [
    'z-healthy.example',
    'c-failing.example',
    'a-healthy.example',
    'b-failing.example',
  ];
  const sorted = Array.from(
    sortSites(order, {
      'z-healthy.example': { failing: 0 },
      'c-failing.example': { failing: 1 },
      'a-healthy.example': { failing: 0 },
      'b-failing.example': { failing: 4 },
    })
  );
  assert.deepEqual(sorted, [
    'b-failing.example',
    'c-failing.example',
    'a-healthy.example',
    'z-healthy.example',
  ]);
  assert.deepEqual(order, [
    'z-healthy.example',
    'c-failing.example',
    'a-healthy.example',
    'b-failing.example',
  ]);
  assert.match(app, /const cards = healthSiteOrder\(order, sites\)/);
});

test('Health summarizes response-pattern failures and discloses raw detail on demand', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const start = app.indexOf('function healthFailureMarkup(error, index)');
  const end = app.indexOf('\n}\n\nasync function renderHealth', start) + 2;
  assert.ok(start >= 0 && end > start);
  const markup = vm.runInNewContext(`${app.slice(start, end)}; healthFailureMarkup`, {
    esc: value =>
      String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;'),
  });
  const detail = '<!doctype html><html lang="en"> (truncated) == pat(*searchwoot.com*)';
  const result = markup(detail, 0);
  assert.match(result, /<summary>Body pattern check failed: searchwoot\.com<\/summary>/);
  assert.match(result, /<code>&lt;!doctype html&gt;&lt;html lang=&quot;en&quot;&gt;/);
  assert.doesNotMatch(result, /<code><!doctype html>/);
  assert.match(style, /\.health-failure-detail code \{[^}]*max-height: 8em;[^}]*overflow: auto/);
});

test('Containers provides scoped search and operational filters', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="cn-summary"/);
  assert.match(app, /class="page-title">Containers<\/h2>/);
  assert.match(app, /type="button" class="btn" id="containers-refresh"/);
  assert.match(app, /Listing containers…/);
  assert.match(
    app,
    /\$\('#containers-refresh'\)\.addEventListener\('click', \(\) => renderContainers\(\)\)/
  );
  assert.match(app, /id="cn-search"/);
  assert.match(app, /id="cn-status"/);
  assert.match(app, /id="cn-kind"/);
  assert.match(app, /function applyContainerFilter\(\)/);
  assert.match(app, /data-cn-status/);
  assert.match(
    app,
    /class="card cn-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect container health and lifecycle actions<\/div><div class="table-wrap" tabindex="0" role="region" aria-label="Container runtime status and lifecycle controls"><table><caption class="sr-only">Container runtime status and lifecycle controls<\/caption>/
  );
  assert.match(
    app,
    /class="btn sm cn-logs" data-id="\$\{esc\(r\.id\)\}" aria-expanded="false" aria-controls="cn-detail-/
  );
  assert.match(app, /aria-label="Restart \$\{esc\(r\.name\)\}"/);
  assert.match(app, /trigger\?\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(app, /class="cn-help"><summary>What container actions do/);
  assert.match(theme, /\.cn-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.cn-table \{[^}]*overflow: hidden/);
  assert.match(theme, /\.cn-filter-hidden \{ display: none; \}/);
});

test('Errors presents scan severity as a readable KPI strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="error-summary"/);
  assert.match(app, /Reporting errors · 1h<\/span>/);
  assert.match(app, /Critical lines · 24h<\/span>/);
  assert.match(
    app,
    /class="task-toolbar errors-toolbar" role="group" aria-label="Error scan filters"/
  );
  assert.match(app, /class="error-help"><summary>How errors are classified/);
  assert.match(app, /const postFailureGroups = \[\]/);
  assert.match(app, /Deduplicated failed Slack delivery patterns/);
  assert.match(
    app,
    /failed Slack post\(s\) across \$\{postFailureGroups\.length\} failure pattern/
  );
  assert.match(app, /aria-label="Open retained logs for \$\{esc\(r\.name\)\}"/);
  assert.match(app, /type="button" class="btn" id="errors-refresh"/);
  assert.match(
    app,
    /\$\('#errors-refresh'\)\.addEventListener\('click', \(\) => renderErrors\(\)\)/
  );
  assert.match(
    app,
    /class="card error-card error-table"><div class="table-wrap"><table><caption class="sr-only">Container error summary and retained log actions<\/caption>/
  );
  assert.match(theme, /\.error-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.error-banner-bad \{[^}]*border-left/);
});

test('Deploys provides status hierarchy and scoped filtering', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="deploy-summary-grid"/);
  assert.match(app, /type="button" class="btn" id="deploy-refresh"/);
  assert.match(app, /Loading deploy health…/);
  assert.match(
    app,
    /\$\('#deploy-refresh'\)\.addEventListener\('click', \(\) => renderDeployHealth\(\)\)/
  );
  assert.match(app, /id="deploy-search"/);
  assert.match(app, /id="deploy-status"/);
  assert.match(app, /function applyDeployFilter\(\)/);
  assert.match(app, /data-deploy-status/);
  assert.match(
    app,
    /class="card deploy-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare deployment status, versions, and errors<\/div><div class="table-wrap" tabindex="0" role="region" aria-label="Deployment health by site"><table/
  );
  assert.match(app, /Deployment health by site/);
  assert.match(app, /class="deploy-help"><summary>How deployment status is determined/);
  assert.match(theme, /\.deploy-summary-grid \{[^}]*grid-template-columns/);
  assert.match(theme, /\.deploy-table \{[^}]*overflow: hidden/);
  assert.match(theme, /\.deploy-filter-hidden \{ display: none; \}/);
});

test('Site Facts presents coverage and freshness as a summary strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="sf-summary"/);
  assert.match(app, /Checks present<\/span>/);
  assert.match(app, /Awaiting data<\/span>/);
  assert.match(app, /type="button" class="btn" id="sitefacts-refresh"/);
  assert.match(
    app,
    /\$\('#sitefacts-refresh'\)\.addEventListener\('click', \(\) => reloadSiteFacts\(\)\)/
  );
  assert.match(app, /class="card sf-table-card"><div class="table-wrap"><table class="sf-table"/);
  assert.match(app, /class="sf-help"><summary>How to read Site Facts/);
  assert.match(theme, /\.sf-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.sf-legend-present i \{[^}]*background: var\(--green\)/);
});

test('Git Operations presents repository state with local filters', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="git-summary"/);
  assert.match(app, /<nav class="git-page-tabs" aria-label="Git workspace">/);
  assert.match(app, /active === 'operations' \? 'aria-current="page"'/);
  assert.match(app, /active === 'hygiene' \? 'aria-current="page"'/);
  assert.doesNotMatch(app, /class="git-page-tabs" role="tablist"/);
  assert.match(app, /id="git-search"/);
  assert.match(app, /id="git-status"/);
  assert.match(app, /type="button" class="btn sm" id="git-refresh"/);
  assert.match(app, /\$\('#git-refresh'\)\.addEventListener\('click', \(\) => renderGit\(\)\)/);
  assert.match(app, /function applyGitFilter\(\)/);
  assert.match(app, /data-git-status/);
  assert.match(app, /Surface repositories that need operator action before the clean fleet/);
  assert.match(app, /const gitRank = r =>/);
  assert.match(app, /rows\.sort\(\(a, b\) => gitRank\(a\) - gitRank\(b\)/);
  assert.match(theme, /\.git-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.git-filter-hidden \{ display: none; \}/);
});

test('Domain Control presents fleet role health as a summary strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="ctl-summary"/);
  assert.match(app, /type="button" class="btn" id="control-refresh"/);
  assert.match(
    app,
    /\$\('#control-refresh'\)\.addEventListener\('click', \(\) => renderControl\(\)\)/
  );
  assert.match(app, /Fleet role coverage<\/h2>/);
  assert.match(app, /role issues include stale, overdue, or missing logs/);
  assert.match(app, /Fully green sites<\/span>/);
  assert.match(app, /Sites with role issues<\/span>/);
  assert.match(app, /Sites with paused roles<\/span>/);
  assert.doesNotMatch(app, /Common role columns<\/span>/);
  assert.match(app, /Has fresh roles/);
  assert.match(app, /matrix-scroll-hint/);
  assert.match(app, /class="rmatrix-tools"><summary aria-label="More tools for/);
  assert.match(app, /Parked domain inventory and renewal exposure/);
  assert.doesNotMatch(app, /Fresh role cells<\/span>/);
  assert.match(theme, /\.ctl-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.matrix-scroll-hint \{ display: none; \}/);
  assert.match(theme, /\.rmatrix thead th \{[\s\S]*position: sticky/);
  assert.match(theme, /\.rmatrix thead th\.rsite-h \{ left: 0; z-index: 5; \}/);
  assert.match(theme, /\.rmatrix th\.rsite-h,[\s\S]*width: 240px/);
});

test('wide rendered tables receive consistent mobile scroll affordances', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function enhanceScrollableTables\(root\)/);
  assert.match(app, /root\.querySelectorAll\('table'\)/);
  assert.match(app, /getComputedStyle\(wrap\)\.overflowX/);
  assert.match(app, /wrap\.scrollWidth > wrap\.clientWidth \+ 1/);
  assert.match(
    app,
    /wrap\.tabIndex = 0;\s+wrap\.setAttribute\('role', 'region'\);\s+wrap\.setAttribute\('aria-label', label\)/
  );
  assert.match(app, /Swipe horizontally to inspect all columns/);
  assert.match(app, /const hintSelector = '\[role="note"\]\[class\*="scroll-hint"\]'/);
  assert.match(app, /panel\?\.querySelectorAll\(hintSelector\)/);
  assert.match(app, /root\.children\]\.some\(\s*child => child\.matches\(hintSelector\)/);
  assert.match(
    app,
    /Promise\.resolve\(renderCurrentView\(\)\)\.then\(\(\) => \{\s+const app = \$\('#app'\);\s+enhanceScrollableTables\(app\);\s+removeDuplicatePageRefresh\(app\);/
  );
});

test('shared view refresh replaces duplicate generic page-head refresh actions', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(app, /function removeDuplicatePageRefresh\(root\)/);
  assert.match(app, /mainHead\?\.querySelectorAll\('button\[id\$="-refresh"\]'\)/);
  assert.match(app, /if \(label === 'Refresh'\) button\.remove\(\)/);
  assert.match(app, /removeDuplicatePageRefresh\(app\)/);
  assert.match(
    index,
    /id="refresh" class="btn" type="button" aria-label="Refresh dashboard data" title="Refresh this view and preserve filters and scroll"/
  );
});

test('improvement run summary stays compact on mobile', () => {
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    style,
    /@media \(max-width: 720px\)[\s\S]*body\[data-view="improvements"\] \.seo-stats[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/
  );
  assert.match(style, /body\[data-view="delivery"\] \.seo-stats/);
});

test('shell title injection does not duplicate nested custom-view headings', () => {
  const shell = fs.readFileSync(path.join(publicDir, 'shell.js'), 'utf8');
  assert.match(
    shell,
    /app\.querySelector\(':scope > \.page-head, :scope > \.crumbs, \.page-head \.page-title'\)/
  );
});

test('Agents landing cards use light surfaces in light theme', () => {
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.nav-root-card \{[\s\S]*background:[\s\S]*linear-gradient\(145deg, #fff, #f5f8fd\)/
  );
  assert.match(theme, /\.nav-root-card-copy strong \{ color: var\(--text-hi\);/);
});

test('Git Hygiene presents safety state and searchable review queue', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="gh-summary"/);
  assert.match(app, /Repos needing review<\/span>/);
  assert.match(app, /paths awaiting decision/);
  assert.match(app, /Review queue \(\$\{filteredQueue\.length\} paths\)/);
  assert.match(app, /<h2>Review queue \(\$\{filteredQueue\.length\} paths\)<\/h2>/);
  assert.match(app, /<h2>Last sweep<\/h2>/);
  assert.match(app, /Swipe horizontally to review paths and choose an action/);
  assert.match(app, /role="region" aria-label="Git hygiene review queue"/);
  assert.match(app, /role="region" aria-label="Git hygiene last sweep results"/);
  assert.match(app, /id="gh-search"/);
  assert.match(app, /id="gh-refresh"/);
  assert.match(
    app,
    /\$\('#gh-refresh'\)\.addEventListener\('click', \(\) => renderGitHygiene\(\)\)/
  );
  assert.match(app, /Repositories swept<\/span>/);
  assert.match(app, /Blocked paths<\/span>/);
  assert.match(app, /function applyGitHygieneFilter\(\)/);
  assert.match(app, /const GH_PAGE_SIZE = 50/);
  assert.match(app, /class="gh-pagination" aria-label="Git hygiene review pages"/);
  assert.match(app, /id="gh-page-prev"/);
  assert.match(app, /id="gh-page-next"/);
  assert.match(theme, /\.gh-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.gh-panel h2 \{ font-size: 1\.17em; \}/);
  assert.match(theme, /\.gh-pagination \{[^}]*display: flex/);
  assert.match(theme, /\.gh-filter-hidden \{ display: none; \}/);
});

test('Task Budget presents audit risk and participates in fleet filtering', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /type="button" class="btn" id="task-budget-refresh"/);
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="tb-summary"/);
  assert.match(app, /Budget drift<\/span>/);
  assert.match(app, /Dead-role tasks<\/span>/);
  assert.match(app, /<details class="card tb-site-card" data-fleet-row/);
  assert.match(
    app,
    /class="tb-site-summary"><strong>\$\{esc\(s\.site\)\}<\/strong><span class="muted">\$\{s\.roles\.length\} roles<\/span>/
  );
  assert.match(
    app,
    /<span class="badge \$\{siteDrift \? 'b-yellow' : 'b-gray'\}">\$\{siteDrift\} drift<\/span>/
  );
  assert.match(app, /risk\(b\) - risk\(a\) \|\| a\.site\.localeCompare\(b\.site\)/);
  assert.match(app, /aria-label="Task budget site pages"/);
  assert.match(
    app,
    /const matchingCards = budgetCards\.filter\(card => !card\.classList\.contains\('fleet-hidden'\)\)/
  );
  assert.match(app, /globalThis\.updateTaskBudgetPagination = updateBudgetPage/);
  assert.match(app, /globalThis\.updateTaskBudgetPagination\?\.\(\)/);
  assert.match(app, /\$\{esc\(s\.site\)\} task budget roles/);
  assert.match(app, /applyFleetFilter\(\);/);
  assert.match(theme, /\.tb-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.tb-site-summary \{[^}]*display: flex/);
  assert.match(theme, /\.tb-page-hidden \{ display: none !important; \}/);
  assert.match(theme, /\.tb-pagination \{[^}]*display: flex/);
});

test('Dev Sandboxes presents runtime readiness and scoped filters', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="ds-summary"/);
  assert.match(app, /id="ds-search"/);
  assert.match(app, /id="ds-status"/);
  assert.match(app, /type="button" class="btn" id="ds-refresh"/);
  assert.match(app, /Docker control plane<\/span>/);
  assert.match(app, /function applyDevSandboxFilter\(\)/);
  assert.match(app, /Development sandbox status/);
  assert.match(theme, /\.ds-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.ds-filter-hidden \{ display: none; \}/);
});

test('Activity presents audit volume and outcome hierarchy', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="activity-summary"/);
  assert.match(app, /Actions loaded<\/span>/);
  assert.match(app, /type="button" class="btn" id="activity-refresh"/);
  assert.match(app, /Latest event · \$\{filtered\.length\} matching/);
  assert.match(
    app,
    /class="task-toolbar activity-toolbar" role="group" aria-label="Activity filters"/
  );
  assert.match(app, /class="card activity-table"><div class="table-wrap"><table/);
  assert.match(app, /Operator activity audit trail/);
  assert.match(app, /class="activity-help"><summary>What this audit trail records/);
  assert.match(theme, /\.activity-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.activity-table \{[^}]*overflow: hidden/);
});

test('Product Feed presents queue health as a summary strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /type="button" class="btn" id="product-feed-refresh"/);
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="pf-summary"/);
  assert.match(app, /Queues below target<\/span>/);
  assert.match(app, /Verified products<\/span>/);
  assert.match(app, /class="card pf-panel"/);
  assert.equal(
    (app.match(/class="matrix-scroll-hint" role="note">Swipe horizontally to/g) || []).length >= 2,
    true
  );
  assert.match(app, /\$\$\('\.pf-panel \.table-wrap', app\)\.forEach\(wrap =>/);
  assert.match(app, /wrap\.setAttribute\('role', 'region'\)/);
  assert.match(app, /class="pf-help"><summary>How the product feed is maintained/);
  assert.match(
    app,
    /caption class="sr-only">Product feed subscriptions and queue health<\/caption>/
  );
  assert.match(app, /Verified Amazon inventory for independent site publishing queues/);
  assert.doesNotMatch(app, /queues \(:4761\)/);
  assert.match(app, /Showing \$\{productItems\.length\} most recent<\/span>/);
  assert.match(app, /caption class="sr-only">Most recently verified Amazon products<\/caption>/);
  assert.match(theme, /\.pf-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.pf-panel \{[^}]*overflow: hidden/);
});

test('AI Inventory presents provider and policy coverage as a summary strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /type="button" class="btn" id="ai-inventory-refresh"/);
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="aii-summary"/);
  assert.match(
    app,
    /id="aii-search" aria-label="Search AI inventory by service, provider, model, dispatch, or function"/
  );
  assert.match(app, /id="aii-site" aria-label="Filter AI inventory by site"/);
  assert.match(app, /className = 'aii-pagination'/);
  assert.match(app, /const inventoryPageSize = 20/);
  assert.match(app, /AI-backed services<\/span>/);
  assert.match(app, /No-AI services · \$\{s\.conditional \|\| 0\} conditional/);
  assert.match(
    app,
    /class="card aii-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare branch, working-tree, and remote status<\/div><div class="table-wrap" tabindex="0" role="region" aria-label="Fleet repository status"><table/
  );
  assert.match(app, /AI service inventory/);
  assert.match(app, /class="aii-help"><summary>How to interpret AI inventory/);
  assert.match(theme, /\.aii-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.aii-controls \{[^}]*flex-wrap: wrap/);
  assert.match(theme, /\.aii-paginated-row\[hidden\] \{ display: none !important; \}/);
  assert.match(theme, /\.aii-table \{[^}]*overflow: hidden/);
});

test('Compliance keeps scan controls explicit and safe', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    app,
    /class="task-toolbar compliance-toolbar" role="group" aria-label="Compliance filters and actions"/
  );
  assert.match(
    app,
    /role="status" aria-live="polite"><div class="loading">Loading live compliance evidence…<\/div>/
  );
  assert.doesNotMatch(app, /compliance-refresh/);
  assert.match(
    app,
    /compliance-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare compliance checks, evidence, and scan dates<\/div><div class="table-wrap" tabindex="0" role="region" aria-label="Compliance evidence by site"><table>/
  );
  assert.match(app, /Compliance evidence by site/);
  assert.match(app, /class="compliance-trend" role="img" aria-label="Fleet pass rate trend from/);
  assert.match(app, /class="compliance-trend-range" aria-hidden="true"/);
  assert.match(app, /id="compliance-scan" class="btn sm compliance-scan"/);
  assert.match(app, /type="button" class="badge .*compliance-status/);
  assert.match(
    app,
    /compliance-status" data-site="\$\{esc\(r\.site\)\}" aria-label="Show \$\{esc\(r\.status\)\} compliance evidence for \$\{esc\(r\.site\)\}"/
  );
  assert.match(style, /\.compliance-scan \{ margin-left: auto; \}/);
  assert.match(style, /\.compliance-trend \{[^}]*height: 44px/);
  assert.match(style, /\.compliance-trend-range \{[^}]*justify-content: space-between/);
  assert.match(
    style,
    /\.compliance-filter-tag\[aria-pressed="false"\] \{ border-color: var\(--border-hi\); \}/
  );
});

test('Social Accounts keeps matrix, inventory, and persona tables contextual', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /Social account matrix by site and platform/);
  assert.match(app, /Social account inventory/);
  assert.match(app, /Social personas and account coverage/);
  assert.equal(
    (app.match(/class="sh-scroll-hint" role="note">Swipe horizontally/g) || []).length,
    3
  );
  assert.match(app, /role="region" aria-label="Social account matrix by site and platform"/);
  assert.match(app, /role="region" aria-label="Social account inventory"/);
  assert.match(app, /role="region" aria-label="Social personas and account coverage"/);
  assert.match(app, /class="muted" for="soc-group">Group<\/label>/);
});

test('SEO Intelligence keeps evidence tables bounded and live actions explicit', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    app,
    /role="status" aria-live="polite"><div class="loading">Loading SEO intelligence…<\/div>/
  );
  assert.match(app, /class="btn" id="seo-refresh"/);
  assert.match(
    app,
    /\$\('#seo-refresh'\)\.addEventListener\('click', \(\) => renderSeoIntelligence\(\)\)/
  );
  assert.match(app, /seo-vitals-panel[\s\S]*class="table-wrap"><table class="dh-sources"/);
  assert.match(app, /Web vitals by site/);
  assert.match(
    app,
    /<time datetime="\$\{esc\(vitals\.generated_at\)\}">\$\{esc\(fmtDate\(vitals\.generated_at\)\)\}<\/time>/
  );
  assert.match(app, /SEO opportunity map by site/);
  assert.match(
    app,
    /aria-label="Filter to \$\{esc\(SEO_TYPE_LABELS\[type\] \|\| type\)\} \$\{count\}"/
  );
  assert.match(app, /<th scope="col">CTR<\/th><th scope="col">Actions<\/th>/);
  assert.match(app, /seo-sites[\s\S]*class="table-wrap"><table class="dh-sources"/);
  assert.match(app, /type="button" class="btn sm web-vitals-run"/);
  assert.match(app, /type="button" class="btn sm [^"]*seo-file-task/);
  assert.match(app, /const SEO_PAGE_SIZE = 24/);
  assert.match(app, /class="seo-pagination" aria-label="SEO action pages"/);
  assert.match(app, /id="seo-prev"/);
  assert.match(app, /id="seo-next"/);
  assert.match(style, /body\[data-view="seointelligence"\] \.seo-stats/);
  assert.match(style, /\.seo-vitals-panel, \.seo-sites \{[^}]*overflow: hidden/);
});

test('Backlink Capture keeps coverage tables bounded and actions explicit', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(
    app,
    /role="status" aria-live="polite"><div class="loading">Loading backlink coverage…<\/div>/
  );
  assert.match(app, /type="button" id="backlinks-refresh" class="btn"/);
  assert.match(app, /backlink-table[\s\S]*class="table-wrap"><table class="dh-sources"/);
  assert.match(app, /type="button" id="backlinks-baseline"/);
  assert.match(app, /type="button" id="backlinks-run"/);
  assert.match(app, /type="button" class="btn sm backlink-focus"/);
  assert.match(app, /type="button" class="btn sm backlink-accent backlink-file"/);
  assert.match(app, /caption class="sr-only">Backlink coverage by site<\/caption>/);
  assert.match(app, /<th scope="col">sources<\/th><th scope="col">Actions<\/th>/);
  assert.match(theme, /\.btn\.backlink-accent \{\s*background: #ad5d16/);
  assert.match(theme, /\.btn\.backlink-accent:hover \{[\s\S]*background: #a45714/);
  assert.match(style, /body\[data-view="backlinks"\] \.seo-stats/);
  assert.match(style, /\.backlink-table \{[^}]*overflow: hidden/);
});

test('Lint separates sweep actions, findings, and remediation guidance', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(
    app,
    /role="status" aria-live="polite"><div class="loading">Loading lint sweep…<\/div>/
  );
  assert.match(app, /class="task-toolbar lint-toolbar" role="group" aria-label="Lint actions"/);
  assert.match(app, /class="card lint-table"><div class="table-wrap"><table/);
  assert.match(app, /Lint findings by site/);
  assert.match(app, /<th scope="col">Files<\/th><th scope="col">Actions<\/th>/);
  assert.match(app, /pre-commit hook is skipping these files/);
  assert.match(app, /class="lint-help"><summary>How to remediate lint findings/);
  assert.match(style, /\.lint-table \{[^}]*overflow: hidden/);
});

test('Analytics keeps health and site detail tables bounded', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /function renderAnalytics\(\)[\s\S]*class="table-wrap"><table class="dh-sources"/
  );
  assert.match(
    app,
    /function renderAnalytics\(\)[\s\S]*class="table-wrap"><table class="dh-datasets"/
  );
});

test('AI usage keeps dense cost and diagnostics tables bounded', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('async function renderAIUsage()');
  const end = app.indexOf('/* ===================== DEPLOYS ===================== */', start);
  assert.ok(start >= 0 && end > start);
  const view = app.slice(start, end);
  assert.ok((view.match(/class="table-wrap"><table/g) || []).length >= 8);
  const diagnostics = view.slice(view.indexOf('<details class="card aiu-diagnostics"'));
  assert.ok((diagnostics.match(/class="table-wrap"><table/g) || []).length >= 4);
});

test('AI Usage gives dense tables context and mobile scroll guidance', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /const aiuTableLabels = \[/);
  assert.match(app, /AI usage tracking coverage/);
  assert.match(app, /Swipe horizontally to inspect all columns/);
  assert.match(app, /Filter AI usage by site/);
  assert.match(app, /const aiuPageSize = 20/);
  assert.match(app, /className = 'aiu-pagination'/);
  assert.match(app, /aria-live="polite"/);
  assert.match(style, /\.aiu-paginated-row\[hidden\] \{ display: none !important; \}/);
  assert.match(style, /\.aiu-scroll-hint \{ display: none; \}/);
});

test('AI Usage panels use shared spacing and severity classes', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  const start = app.indexOf('async function renderAIUsage()');
  const end = app.indexOf('/* ===================== DEPLOYS ===================== */', start);
  assert.ok(start >= 0 && end > start);
  const view = app.slice(start, end);
  assert.match(view, /class="card aiu-panel"/);
  assert.match(view, /class="aiu-notice aiu-notice-danger" role="alert"/);
  assert.match(view, /class="aiu-notice" role="note"/);
  assert.match(view, /class="task-toolbar aiu-subhead/);
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.aiu-granularity-btn\.active\s*\{[^}]*color: #174f92/
  );
  assert.doesNotMatch(
    view,
    /style="(?:margin-bottom:14px|margin-top:12px|margin-top:16px|margin-bottom:14px; color: var\(--red\))/
  );
  assert.match(style, /\.aiu-panel \{ margin-bottom: 14px; \}/);
  assert.match(style, /\.aiu-notice \{ display: block; min-height: 0;/);
  assert.match(
    style,
    /\.aiu-notice-danger \{ border-left-color: var\(--red\); color: var\(--text\); \}/
  );
});

test('Guardrails uses bounded tables and shared panel controls', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const start = app.indexOf('async function renderGuardrails()');
  const end = app.indexOf('async function grSaveConfig', start);
  assert.ok(start >= 0 && end > start);
  const view = app.slice(start, end);
  assert.equal((view.match(/class="card gr-panel"/g) || []).length, 4);
  assert.equal((view.match(/class="table-wrap" tabindex="0" role="region"/g) || []).length, 2);
  assert.equal(
    (view.match(/class="matrix-scroll-hint" role="note">Swipe horizontally to/g) || []).length,
    2
  );
  assert.match(
    view,
    /role="status" aria-live="polite"><div class="loading">Loading guardrails…<\/div>/
  );
  assert.match(view, /type="button" id="guardrails-refresh" class="btn"/);
  assert.match(view, /aria-label="Add global blocked term"/);
  assert.match(view, /class="gr-term-input"/);
  assert.match(view, /gr-title-note/);
  assert.doesNotMatch(view, /style="(?:margin-top:0|margin-top:8px|max-width:)/);
  assert.match(style, /\.gr-panel \{ margin-bottom: 14px; \}/);
  assert.match(style, /\.gr-term-input \{ max-width: 280px; \}/);
});

test('operational inventory tables stay bounded on narrow viewports', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const taskBudget = app.slice(
    app.indexOf('async function renderTaskBudget()'),
    app.indexOf(
      '/* ===================== AI INVENTORY',
      app.indexOf('async function renderTaskBudget()')
    )
  );
  const inventory = app.slice(
    app.indexOf('async function renderAIInventory()'),
    app.indexOf(
      '/* ===================== PRODUCT FEED',
      app.indexOf('async function renderAIInventory()')
    )
  );
  const sandboxes = app.slice(
    app.indexOf('async function renderDevSandbox()'),
    app.indexOf(
      'function applyDevSandboxFilter()',
      app.indexOf('async function renderDevSandbox()')
    )
  );
  assert.match(taskBudget, /class="table-wrap"><table>/);
  assert.match(inventory, /class="table-wrap"><table>/);
  assert.match(sandboxes, /class="table-wrap"><table>/);
});

test('Data Hub presents privacy and freshness state as a summary strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /class="dh-summary"/);
  assert.match(app, /VPN exits online<\/span>/);
  assert.match(app, /Home-IP leaks<\/span>/);
  assert.match(
    app,
    /class="dh-counts">Skipped records <b>\$\{esc\(String\(\(health\.counts \|\| \{\}\)\.skipped \?\? '—'\)\)\}<\/b>/
  );
  assert.doesNotMatch(app, /class="dh-counts">items <b>/);
  assert.match(app, /Sources enabled<\/span>/);
  assert.match(app, /type="button" class="btn" id="datahub-refresh"/);
  assert.match(app, /Loading Data Hub…/);
  assert.match(
    app,
    /\$\('#datahub-refresh'\)\.addEventListener\('click', \(\) => renderDataHub\(\)\)/
  );
  assert.match(app, /class="dh-help"><summary>How Data Hub protects and routes collection/);
  assert.match(
    app,
    /class="matrix-scroll-hint dh-scroll-hint" role="note">Swipe horizontally inside wide tables to reveal remaining columns/
  );
  assert.match(app, /wrap\.setAttribute\('role', 'region'\)/);
  assert.match(app, /table\.caption\?\.textContent\?\.trim\(\) \|\| 'Data Hub table'/);
  assert.match(app, /class="table-wrap"><table class="dh-egress"/);
  assert.match(app, /Outbound connection ledger/);
  assert.match(app, /Site data pulls/);
  assert.match(app, /Data source freshness and controls/);
  assert.match(app, /Collected datasets/);
  assert.match(app, /RSS subscriptions by site/);
  assert.match(app, /Dataset subscriptions by site/);
  assert.match(app, /const dhPageSize = 20/);
  assert.match(app, /pager\.setAttribute\('aria-label', `\$\{label\} pages`\)/);
  assert.match(app, /className = 'dh-pagination'/);
  assert.match(app, /<th scope="col">Actions<\/th>/);
  assert.match(app, /<th scope="col">Subscribed datasets<\/th>/);
  assert.match(app, /type="button" class="btn sm .*dh-src-toggle/);
  assert.match(style, /\.dh-pagination \{[^}]*display: flex/);
  assert.match(theme, /\.dh-summary \{[^}]*grid-template-columns/);
  assert.match(style, /\.dh-help \{[^}]*border-top/);
});

test('Data Hub Images uses shared loading and bounded ledger patterns', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('async function renderDataHubImages()');
  const end = app.indexOf('// Toggle a data-hub-images source', start);
  assert.ok(start >= 0 && end > start);
  const view = app.slice(start, end);
  assert.match(view, /class="loading">Loading Data Hub Images/);
  assert.match(view, /class="page-head"><h2 class="page-title">Data Hub Images/);
  assert.match(view, /type="button" class="btn" id="datahub-images-refresh"/);
  assert.match(
    view,
    /\$\('#datahub-images-refresh'\)\.addEventListener\('click', \(\) => renderDataHubImages\(\)\)/
  );
  assert.match(app, /<div class="table-wrap"><table class="\$\{tableClass\}"/);
  assert.match(view, /dhiLedgerTableHtml\(/);
  assert.match(app, /class="sr-only">\$\{esc\(title\)\} counts/);
  assert.match(view, /Image source freshness and controls/);
  assert.match(view, /<th scope="col">Actions<\/th>/);
  assert.match(view, /Image outbound connection ledger/);
  assert.match(view, /Image site data pulls/);
  assert.match(app, /type="button" class="btn sm danger dhi-blacklist/);
  assert.match(view, /type="button" class="btn sm .*dhi-src-toggle/);
  assert.match(app, /const DHI_PAGE_SIZE = 20/);
  assert.match(app, /function dhiCountBlockHtml\(key, title, entries\)/);
  assert.match(
    app,
    /function dhiLedgerTableHtml\(key, title, headers, rows, tableClass, emptyText\)/
  );
  assert.match(app, /rows\.slice\(start, start \+ DHI_PAGE_SIZE\)/);
  assert.match(app, /entries\s*\.slice\(start, start \+ DHI_PAGE_SIZE\)/);
  assert.match(app, /images\s*\.slice\(start, start \+ DHI_PAGE_SIZE\)\s*\.map\(dhiImageCard\)/);
  assert.match(view, /id="dhi-image-gallery"/);
  assert.match(view, /dhiBindCountControls\(app\)/);
  assert.match(view, /dhiBindLedgerControls\(app\)/);
  assert.match(view, /dhiBindImageActions\(imageGallery\)/);
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(style, /\.dhi-pagination \{/);
  assert.match(
    style,
    /\.dhi-stats-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/
  );
  assert.match(
    style,
    /@media \(max-width: 560px\) \{ \.dhi-stats-grid \{ grid-template-columns: minmax\(0, 1fr\); \} \}/
  );
});

test('data-heavy routes use the shared production loading state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /async function renderDataHub\(\)[\s\S]*?class="loading">Loading Data Hub/);
  assert.match(
    app,
    /async function renderBacklinks\(\)[\s\S]*?class="loading">Loading backlink coverage/
  );
  assert.match(app, /async function renderAnalytics\(\)[\s\S]*?class="loading">Loading analytics/);
  assert.doesNotMatch(
    app,
    /async function renderDataHub\(\)[\s\S]*?class="muted">loading data hub/
  );
  assert.doesNotMatch(
    app,
    /async function renderBacklinks\(\)[\s\S]*?class="muted">loading backlink/
  );
  assert.doesNotMatch(
    app,
    /async function renderAnalytics\(\)[\s\S]*?class="muted">loading analytics/
  );
});

test('secondary async panels use the shared compact loading treatment', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(theme, /\.async-loading::before[\s\S]*loading-spin/);
  assert.match(theme, /pre\.async-loading[\s\S]*padding-left/);
  assert.match(app, /class="async-loading">Loading…/);
  assert.match(app, /class="cn-logs-box async-loading"/);
  assert.match(app, /pre\.classList\.remove\('async-loading'\)/);
});

test('workbench board styling has one authoritative responsive definition', () => {
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.equal((style.match(/\.wb-board\s*\{\s*display:/g) || []).length, 1);
  assert.equal((style.match(/\.wb-card\s*\{\s*display:/g) || []).length, 1);
  assert.equal((style.match(/\.wb-head\s*\{\s*align-items: flex-end/g) || []).length, 1);
  assert.match(style, /\.wb-link-list\s*\{/);
});

test('Active Delivery paginates the complete attention queue', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const delivery = app.slice(
    app.indexOf('let ACTIVE_DELIVERY_ATTENTION_PAGE'),
    app.indexOf('let IMPROVEMENT_STATE', app.indexOf('let ACTIVE_DELIVERY_ATTENTION_PAGE'))
  );
  assert.match(app, /const ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE = 12/);
  assert.match(
    delivery,
    /attention\s*\.slice\(attentionStart, attentionStart \+ ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE\)/
  );
  assert.match(delivery, /aria-label="Delivery attention pages"/);
  assert.match(
    delivery,
    /Showing \$\{attentionStart \+ 1\}–\$\{Math\.min\(attentionStart \+ ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE, attention\.length\)\} of \$\{attention\.length\} flagged items/
  );
  assert.match(
    delivery,
    /ACTIVE_DELIVERY_ATTENTION_PAGE = Math\.max\(1, ACTIVE_DELIVERY_ATTENTION_PAGE - 1\)/
  );
  assert.match(delivery, /ACTIVE_DELIVERY_ATTENTION_PAGE \+ 1/);
  assert.doesNotMatch(delivery, /data\.attention \|\| \[\]\)\s*\.slice\(0, 12\)/);
});

test('Active Delivery flow card is inset and avoids repeating its deployment KPI', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  const start = app.indexOf("app.querySelector('.seo-stats')?.insertAdjacentHTML(");
  const end = app.indexOf("$('#delivery-refresh')", start);
  assert.ok(start >= 0 && end > start);
  const flow = app.slice(start, end);
  assert.match(flow, /class="card cq-delivery-flow"/);
  assert.doesNotMatch(flow, /flow\.deployed_today/);
  assert.match(theme, /\.cq-delivery-flow \{[^}]*padding:\s*14px 16px/);
});

test('Site Facts and executive evidence tables stay bounded when expanded', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const facts = app.slice(
    app.indexOf('async function sfRenderPanel('),
    app.indexOf('function reloadSiteFacts()', app.indexOf('async function sfRenderPanel('))
  );
  const priorities = app.slice(
    app.indexOf('async function renderPriorities()'),
    app.indexOf('let IMPROVEMENT_STATE', app.indexOf('async function renderPriorities()'))
  );
  const improvements = app.slice(
    app.indexOf('async function renderImprovements()'),
    app.indexOf('function improvementActions', app.indexOf('async function renderImprovements()'))
  );
  assert.ok((facts.match(/class="table-wrap"><table class="sf-detail-table"/g) || []).length >= 2);
  assert.ok((priorities.match(/class="table-wrap"[^>]*><table class="tbl"/g) || []).length >= 2);
  assert.equal(
    (priorities.match(/class="matrix-scroll-hint priority-scroll-hint" role="note"/g) || []).length,
    2
  );
  assert.match(
    priorities,
    /class="table-wrap" tabindex="0" role="region" aria-label="Prioritized recommended actions"/
  );
  assert.match(
    priorities,
    /role="status" aria-live="polite"><div class="loading">Joining portfolio signals…<\/div>/
  );
  assert.match(priorities, /type="button" id="priorities-refresh" class="btn"/);
  assert.match(app, /const PRIORITY_PAGE_SIZE = 25/);
  assert.match(priorities, /class="priority-pagination" aria-label="Priority action pages"/);
  assert.match(priorities, /id="priority-prev"/);
  assert.match(priorities, /id="priority-next"/);
  assert.match(
    priorities,
    /id="priority-state" class="cm-input" aria-label="Filter prioritized actions by state"/
  );
  assert.match(priorities, /<th scope="col">Action<\/th>/);
  assert.match(priorities, /caption class="sr-only">Prioritized recommended actions<\/caption>/);
  assert.match(priorities, /class="fd-stale-banner priority-notice" role="note"/);
  assert.match(priorities, /class="priority-duplicates"/);
  assert.match(priorities, /identical tasks grouped/);
  assert.match(priorities, /\(item\.task\?\.files \|\| \[\]\)\.map/);
  assert.match(priorities, /class="fd-stale-banner priority-truncated" role="alert"/);
  assert.match(
    priorities,
    /The API reports \$\{reportedTotal\} recommendations but returned \$\{all\.length\}/
  );
  assert.doesNotMatch(priorities, /<div class="error-box">\$\{esc\(data\.notice/);
  assert.match(app, /const IMPROVEMENT_PAGE_SIZE = 20/);
  assert.match(improvements, /<h4>Quality gates<\/h4><div class="table-wrap"><table class="tbl">/);
  assert.match(
    improvements,
    /role="status" aria-live="polite"><div class="loading">Loading improvement runs…<\/div>/
  );
  assert.match(improvements, /type="button" id="improvements-refresh" class="btn"/);
  assert.match(
    improvements,
    /id="improvement-state" class="cm-input" aria-label="Filter improvement runs by state"/
  );
  assert.match(improvements, /class="improvement-pagination" aria-label="Improvement run pages"/);
  assert.match(improvements, /id="improvements-prev"/);
  assert.match(improvements, /id="improvements-next"/);
  assert.match(improvements, /class="improvement-visual-compare"/);
  assert.match(improvements, /class="improvement-live-review"/);
  assert.match(improvements, /data-review-preview=/);
  assert.match(improvements, /loading="lazy" src="\$\{esc\(productionUrl\)\}"/);
  assert.match(improvements, /const productionUrl = safeHref/);
  assert.doesNotMatch(improvements, /style="display:grid;grid-template-columns:1fr 1fr/);
});

test('fleet task view presents the filtered slice as a summary strip', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(app, /class="tasks-summary"/);
  assert.match(app, /Visible tasks<\/span>/);
  assert.match(app, /Blocked<\/span>/);
  assert.match(app, /new Set\(rows\.map\(t => t\.site\)\)/);
  assert.match(theme, /\.tasks-summary \{[^}]*grid-template-columns/);
  assert.match(theme, /\.task-stat-warn/);
  assert.match(app, /id="task-search" class="cm-input" type="search"/);
  assert.match(app, /aria-label="Search fleet tasks"/);
  assert.match(app, /TASK\.f\.query/);
  assert.match(app, /Active sites open by default; expand a stage to browse its tasks/);
  assert.match(app, /const hasAttention = ip > 0 \|\| tasks\.some\(t => t\.blocked_on\)/);
  assert.match(app, /class="tree-stage" data-rk="tree-stage:/);
  assert.match(app, /const open = stage === 'in-progress' \|\| blocked > 0/);
  assert.match(app, /\$\$\('\.tree-site, \.tree-stage'\)/);
  assert.match(style, /\.tree-stage > summary \{ display: flex;/);
  assert.match(style, /\.tree-control-actions \{ display: flex;/);
});

test('repeated task titles are disclosed without collapsing distinct task files', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /const repeatedTitles = new Map\(\)/);
  assert.match(app, /\[task\.site, task\.title\]\.join\('\\u001f'\)/);
  assert.match(app, /function boardCard\(t, duplicateCount = 1\)/);
  assert.match(app, /matching titles/);
  assert.match(app, /each remains a separate task/);
  assert.match(theme, /\.task-repeat-note \{/);
});

test('fleet task filters stay compact by default and disclose the active selection', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /<details class="filter-panel" data-rk="filters">/);
  assert.match(app, /activeLabels\.slice\(0, 2\)/);
  assert.match(app, /Clear all filters/);
  assert.match(app, /id="clear-filters" type="button"/);
  assert.match(style, /\.filter-actions \{/);
  assert.match(theme, /\.task-stat-meta \{ grid-column: span 2; \}/);
});

test('Tasks route provides context before its mode controls', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  const start = app.indexOf('async function renderTasks()');
  const end = app.indexOf('/* ---- Board (per-site CRUD kanban) ---- */', start);
  assert.ok(start >= 0 && end > start);
  const view = app.slice(start, end);
  assert.match(view, /class="page-head task-page-head"/);
  assert.match(view, /<h2 class="page-title">Tasks<\/h2>/);
  assert.match(view, /Track work across the fleet/);
  assert.match(view, /type="button" class="btn" id="tasks-refresh"/);
  assert.match(
    view,
    /\$\('#tasks-refresh'\)\.addEventListener\('click', \(\) => renderTasks\(\)\)/
  );
  assert.match(view, /role="group" aria-label="Task view mode"/);
  assert.match(view, /class="btn primary sm task-new-btn" id="new-task"/);
  assert.match(theme, /\.task-route-toolbar > \.seg \{ display: flex; \}/);
});

test('fleet task table stays bounded while preserving its wide scan columns', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function fleetTable(rows, repeatedTitles');
  const end = app.indexOf('/* ---- shared editor / CRUD ---- */', start);
  assert.ok(start >= 0 && end > start);
  const view = app.slice(start, end);
  assert.match(view, /<div class="card"><div class="table-wrap"><table class="tasks-table">/);
  assert.match(view, /<th>Title<\/th><th>Role<\/th><th>Created<\/th>/);
});

test('fleet task tree separates site and stage expansion, prioritizing active work', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const tree = app.slice(app.indexOf('function fleetTree('), app.indexOf('function fleetTable('));
  assert.match(tree, /class="tree-stage" data-rk="tree-stage:/);
  assert.match(tree, /<span class="tree-stage-count">\$\{stageTasks\.length\}/);
  assert.match(tree, /const open = stage === 'in-progress' \|\| blocked > 0/);
  assert.match(tree, /Sites with active work|Active sites open by default/);
  assert.match(app, /\$\$\('\.tree-site, \.tree-stage'\)/);
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(style, /\.tree-stage > summary \{ display: flex;/);
});

test('large per-site task boards paginate each stage without discarding counts', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const controls = app.slice(
    app.indexOf('function renderBoardControls()'),
    app.indexOf('async function loadBoard()')
  );
  const board = app.slice(
    app.indexOf('function renderBoard(data)'),
    app.indexOf('// "Opened" label')
  );
  assert.match(app, /const TASK_BOARD_PAGE_SIZE = 12/);
  assert.match(controls, /<label class="muted" for="task-site">Site<\/label>/);
  assert.match(board, /items\.slice\(start, start \+ TASK_BOARD_PAGE_SIZE\)/);
  assert.match(board, /aria-label="\$\{esc\(COL_LABEL\[col\]\)\} task pages"/);
  assert.match(board, /Page \$\{page\} of \$\{pageCount\} · \$\{start \+ 1\}–/);
  assert.match(board, /Next page of \$\{esc\(COL_LABEL\[col\]\)\} tasks/);
  assert.match(board, /renderBoard\(TASK\.boardData\)/);
});

test('Cron cards isolate schedule overflow and use explicit action buttons', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /type="button" class="btn" id="cron-refresh"/);
  const start = app.indexOf('function cmCard(sys)');
  const end = app.indexOf('function cmRow(sys, e)', start);
  assert.ok(start >= 0 && end > start);
  const card = app.slice(start, end);
  const rowEnd = app.indexOf('// Look up the live entry object', end);
  const row = app.slice(end, rowEnd);
  assert.match(
    card,
    /<div class="table-wrap" tabindex="0" role="region" aria-label="\$\{esc\(sys\.slug\)\} cron jobs and controls"><table class="cm-jobs"><caption class="sr-only">/
  );
  assert.match(card, /<button type="button" class="cm-collapse"/);
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.cm-card,[\s\S]*background: var\(--grad-panel\), #fff;/
  );
  assert.match(style, /\.cm-jobrow\.cm-paused \{ opacity: 1; \}/);
  assert.match(card, /aria-controls="\$\{esc\(bodyId\)\}"/);
  assert.match(
    card,
    /<th scope="col">State<\/th><th scope="col">Job<\/th><th scope="col">Schedule<\/th><th scope="col">Last run<\/th><th scope="col">Actions<\/th>/
  );
  assert.match(app, /function cmHasCollapsePreference\(\)/);
  assert.match(app, /Open Scheduler →/);
  assert.match(
    app,
    /class="matrix-scroll-hint cron-scroll-hint" role="note">Expanded cron job tables swipe horizontally/
  );
  assert.match(app, /!s\.failed && !s\.needsRebuild/);
  assert.match(card, /<button type="button" class="btn sm cm-addjob"/);
  assert.match(row, /type="button" class="btn sm cm-toggle"/);
  assert.match(row, /type="button" class="btn sm danger cm-remove"/);
});

test('Engineer and Git Hygiene action controls declare button intent', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const engineers = app.slice(
    app.indexOf('async function renderEngineers()'),
    app.indexOf('/* ===================== GIT ===================== */')
  );
  const hygiene = app.slice(
    app.indexOf('async function renderGitHygiene()'),
    app.indexOf(
      'function applyGitHygieneFilter()',
      app.indexOf('async function renderGitHygiene()')
    )
  );
  assert.match(engineers, /type="button" class="btn sm tasks-link"/);
  assert.match(
    engineers,
    /class="btn sm tasks-link"[^>]*title="Tasks\$\{r\.queue \? ` \$\{r\.queue\}` : ''\} — open \$\{esc\(r\.site\)\}'s task board"/
  );
  assert.match(
    engineers,
    /id="fleet-help-toggle"[^>]*title="Help — show \/ hide the column key">\? Help<\/button>/
  );
  assert.match(engineers, /type="button" class="btn sm run-eng"/);
  assert.match(engineers, /type="button" class="btn sm .*ag-toggle"/);
  assert.ok((hygiene.match(/type="button" class="btn sm gh-act/g) || []).length >= 5);
});

test('Guides route provides queue context, summary, and keyboard access', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(app, /class="page-head guide-page-head"/);
  assert.match(app, /role="group" aria-label="Guide queue controls"/);
  assert.match(app, /class="guide-summary" aria-label="Guide queue summary"/);
  assert.match(app, /role="button" tabindex="0" aria-label="Open guide/);
  assert.match(app, /\['Enter', ' '\]\.includes\(e\.key\)/);
  assert.match(theme, /\.guide-summary \{[^}]*grid-template-columns: repeat\(5/);
  assert.match(theme, /\.guide-card:focus-visible/);
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

test('active status pills meet contrast and touch-size baselines', () => {
  const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(style, /\.pill \{ min-height: 26px/);
  assert.match(theme, /\.pill\.active \{ background: #286fb9/);
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
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
  assert.match(shell, /data-vt-action="control\?filter=attention"/);
  assert.match(shell, /data-vt-action="containers"/);
  assert.match(shell, /scheduled-role freshness/);
  assert.match(shell, /openVitalView/);
  assert.match(
    shell,
    /class="vitals-mobile-toggle" aria-expanded="false" aria-controls="vitals-content"/
  );
  assert.match(shell, /mobileVitals\.matches\) rail\.classList\.add\('vitals-mobile-collapsed'\)/);
  assert.match(shell, /vitals-mobile-summary/);
  assert.match(shell, /aria-expanded', String\(expanded\)/);
  assert.match(app, /controlFilter/);
  assert.match(app, /CONTROL\.filter === 'fresh'/);
  assert.match(app, /Has fresh roles/);
  assert.match(
    theme,
    /#vitals-content \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);\s*grid-template-rows: auto repeat\(2, auto\)/
  );
  assert.match(
    theme,
    /@media \(max-width: 380px\) \{\s*#vitals-content \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/
  );
  assert.match(theme, /#vitals\.vitals-mobile-collapsed #vitals-content \{ display: none; \}/);
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
  assert.match(index, /id="refresh" class="btn" type="button" aria-label="Refresh dashboard data"/);
  assert.match(index, /id="density-toggle"[^>]*aria-pressed="false"/);
  assert.match(index, /id="theme-toggle"[^>]*aria-pressed="false"/);
  assert.match(index, /<main id="app" aria-busy="true">/);
  assert.doesNotMatch(index, /<button(?![^>]*\btype=)[^>]*>/);
  assert.match(index, /localStorage\.getItem\('fd\.theme'\)/);
  assert.match(
    index,
    /document\.querySelector\('meta\[name="theme-color"\]'\)\?\.setAttribute\('content', theme === 'light' \? '#f4f7fb' : '#070910'\)/
  );
  assert.match(app, /function applyThemeUI\(\)/);
  assert.match(app, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(app, /function watchSystemTheme\(\)/);
  assert.match(app, /prefers-color-scheme: light/);
  assert.match(app, /aria-pressed', String\(theme === 'light'\)/);
  assert.match(app, /aria-pressed', String\(density === 'compact'\)/);
  assert.match(theme, /:root\[data-theme="light"\] \.ex-kpi/);
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.nav-root-card \{[\s\S]*linear-gradient\(145deg, #fff, #f5f8fd\)/
  );
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.task \{[\s\S]*linear-gradient\(180deg, #fff, #f8fafd\)/
  );
  assert.match(
    theme,
    /:root\[data-theme="light"\] #fd-back-top \{[\s\S]*background: rgba\(255,255,255,\.94\)/
  );
  assert.match(theme, /:root\[data-theme="light"\] \.sh-tile/);
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.toast \{[\s\S]*background: linear-gradient\(180deg, rgba\(255,255,255/
  );
  assert.match(
    theme,
    /:root\[data-theme="light"\] option,[\s\S]*background-color: #fff; color: var\(--text\)/
  );
  assert.match(theme, /.wb-status-options {[^}]*position: absolute/);
  assert.match(theme, /.wb-status-options label {[^}]*flex-direction: row/);
  assert.match(theme, /:root\[data-theme="light"\] \.seg-btn\.active/);
  assert.match(theme, /:root\[data-theme="light"\] \.wb-column/);
  assert.match(theme, /:root\[data-theme="light"\] \.wb-card/);
  assert.match(theme, /:root\[data-theme="light"\] \.wb-summary > div/);
  assert.match(theme, /:root\[data-theme="light"\] \.dh-panel/);
  assert.match(theme, /:root\[data-theme="light"\] \.dhi-panel/);
  assert.match(theme, /:root\[data-theme="light"\] \.seo-action/);
  assert.match(theme, /:root\[data-theme="light"\] \.seo-evidence/);
  assert.match(theme, /:root\[data-theme="light"\] \.empty/);
  assert.match(theme, /:root\[data-theme="light"\] \.error-box/);
  assert.match(theme, /:root\[data-theme="light"\] \.dd-item\.active/);
  assert.match(theme, /:root\[data-theme="light"\] \.dd-count\s*\{[^}]*background:/);
  assert.match(theme, /:root\[data-theme="light"\] \.cmdk-hint\s*\{[^}]*background:/);
  assert.match(theme, /:root\[data-theme="light"\] \.fd-shortcuts-grid > div\s*\{[^}]*background:/);
  assert.match(theme, /:root\[data-theme="light"\] \.fd-shortcuts-grid kbd\s*\{[^}]*background:/);
  assert.match(theme, /:root\[data-theme="light"\] \.sh-calendar-intro/);
  assert.match(theme, /:root\[data-theme="light"\] \.cq-request-cell b/);
  assert.match(theme, /:root\[data-theme="light"\] \.cq-command-strip/);
  assert.match(theme, /:root\[data-theme="light"\] \.cq-working-card/);
  assert.match(theme, /:root\[data-theme="light"\] \.ui-collapsible\.is-collapsed/);
  assert.match(theme, /:root\[data-theme="light"\] \.soc-sub/);
  assert.match(theme, /:root\[data-theme="light"\] \.col-head/);
  assert.match(theme, /:root\[data-theme="light"\] \.rmatrix \.rsite-h[\s\S]*box-shadow/);
  assert.match(theme, /:root\[data-theme="light"\] \.fleet-filter-wrap/);
  assert.match(theme, /:root\[data-theme="light"\] \.rl-sec > \.rl-h/);
  assert.match(theme, /:root\[data-theme="light"\] \.rl-it\.on/);
  assert.match(theme, /:root\[data-theme="light"\] \.rl-health-details/);
  assert.match(
    theme,
    /:root\[data-theme="light"\] \.page-title \{[\s\S]*background: linear-gradient/
  );
});

test('agent pages expose enrollment actions that open the automation editor', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const theme = fs.readFileSync(path.join(publicDir, 'theme.css'), 'utf8');
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
  assert.match(app, /Filter sites<input id="ag-missing-filter" type="search"/);
  assert.match(app, /No sites match that filter\./);
  assert.match(app, /wireMissingSiteFilter\(\);/);
  assert.match(
    app,
    /class="matrix-scroll-hint" role="note">Swipe horizontally to inspect agent status and actions/
  );
  assert.match(app, /class="agent-table-wrap" tabindex="0" role="region" aria-label=/);
  assert.match(app, /const agentSiteView = body\s*\? `[\s\S]*class="card agent-table-card"/);
  assert.match(
    app,
    /class="card ag-empty-state" role="status"><strong>No sites enrolled<\/strong>/
  );
  assert.match(theme, /:root\[data-theme="light"\] \* \{ scrollbar-color: #bdc9d9 transparent; \}/);
  assert.match(app, /healthy now/);
  assert.match(app, /7d history/);
  assert.doesNotMatch(app, /<details class="card ag-health" open>/);
  assert.match(app, /missed/);
  assert.match(app, /historical failures/);
  assert.match(app, /Current status is shown first/);
  assert.match(app, /Execution history/);
  assert.match(app, /class="btn sm ag-health-details"[^>]*>Expand<\/button>/);
  assert.match(app, /type="button" class="btn" id="agent-refresh"/);
  assert.match(
    app,
    /\$\('#agent-refresh'\)\.addEventListener\('click', \(\) => renderGenericAgent\(role\)\)/
  );
  assert.match(app, /function toggleHealthDetail\(button\)/);
  assert.match(app, /ag-health-detail-grid/);
  assert.match(app, /function fmtDate\(value\)/);
  assert.match(app, /Pause current issues/);
  assert.match(app, /Rerun historical failures/);
});

test('agent enrollment site filter narrows results and reports an accessible empty state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const start = app.indexOf('function wireMissingSiteFilter()');
  const end = app.indexOf('\n}\n\n// F5:', start) + 2;
  assert.ok(start >= 0 && end > start);
  const nodes = [
    { dataset: { site: '0daynews.com' }, hidden: false },
    { dataset: { site: 'marineactivity.com' }, hidden: false },
    { dataset: { site: 'reviewtattoo.com' }, hidden: false },
  ];
  const input = { value: '', addEventListener: (_event, fn) => (input.oninput = fn) };
  const count = { textContent: '' };
  const empty = { hidden: true };
  const list = { querySelectorAll: () => nodes };
  vm.runInNewContext(`${app.slice(start, end)}; wireMissingSiteFilter();`, {
    $: selector =>
      ({
        '#ag-missing-filter': input,
        '.ag-missing-list': list,
        '#ag-missing-count': count,
        '#ag-missing-no-results': empty,
      })[selector],
  });
  input.value = 'marine';
  input.oninput();
  assert.deepEqual(
    nodes.map(node => node.hidden),
    [true, false, true]
  );
  assert.equal(count.textContent, '1 of 3 sites');
  assert.equal(empty.hidden, true);
  input.value = 'not-a-site';
  input.oninput();
  assert.deepEqual(
    nodes.map(node => node.hidden),
    [true, true, true]
  );
  assert.equal(count.textContent, '0 of 3 sites');
  assert.equal(empty.hidden, false);
});

test('automation exposes a site-scoped refresh and loading state', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const route = app.slice(
    app.indexOf('async function renderAutomation()'),
    app.indexOf('async function renderAgentRuntime()')
  );
  assert.match(route, /id="auto-refresh"/);
  assert.match(route, /type="button" class="btn" id="auto-refresh"/);
  assert.match(route, /Loading automation controls…/);
  assert.match(route, /role="status" aria-live="polite"/);
  assert.match(
    route,
    /\$\('#auto-refresh'\)\.addEventListener\('click', \(\) => renderAutomation\(\)\)/
  );
  assert.match(
    route,
    /if \(!FRESH\) applyUISnap\(\);\s+const siteSelect = \$\('#auto-site'\);\s+if \(siteSelect\) siteSelect\.value = AUTO_SITE;/
  );
});
