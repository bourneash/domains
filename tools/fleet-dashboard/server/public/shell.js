/* ============================================================================
   Domain Fleet Manager — shell.js
   ----------------------------------------------------------------------------
   Progressive-enhancement layer for the redesigned shell. Deliberately knows
   NOTHING about app.js internals: it only observes the DOM app.js already
   produces (body[data-view], .tab[data-view], .dd-item) and adds
     1. the fleet vitals rail
     2. a ⌘K command palette that drives the existing nav
     3. view-entrance motion + button ripples
   If any of it fails, the dashboard is unaffected.
   ========================================================================== */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Labels here are read back out of app.js-rendered nodes via textContent, so
     they arrive DECODED. Re-injecting them into innerHTML would undo app.js's
     own escaping — a role name from disk containing markup would round-trip
     into live HTML. Everything interpolated below goes through esc(). */
  const esc = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  /* A view can fail after the global API/auth bootstrap has succeeded. Keep
     that failure visible without replacing the operator's current workspace,
     and never inject the raw exception into the document. */
  let runtimeAlert = null;
  let runtimeIssue = null;
  function runtimeNotice(message, kind = 'ok') {
    if (typeof globalThis.fleetToast === 'function') {
      globalThis.fleetToast(message, kind);
      return;
    }
    const toast = document.querySelector('#toast');
    if (!toast) return;
    const messageEl = toast.querySelector('#toast-message');
    if (messageEl) messageEl.textContent = message;
    else toast.textContent = message;
    toast.className = `toast show ${kind}`;
    clearTimeout(runtimeNotice.timer);
    runtimeNotice.timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }
  function renderRuntimeAlert() {
    if (!runtimeAlert || !runtimeIssue) return;
    runtimeAlert.innerHTML = `
      <div class="fd-runtime-alert-head"><span class="fd-runtime-alert-icon" aria-hidden="true">!</span><div><strong>Dashboard view interrupted</strong><span>${runtimeIssue.count > 1 ? `${runtimeIssue.count} UI errors detected` : 'The current page may be incomplete.'}</span></div><button class="fd-runtime-alert-dismiss" type="button" data-runtime-dismiss aria-label="Dismiss dashboard error">×</button></div>
      <details><summary>Show diagnostic</summary><code>${esc(runtimeIssue.message)}</code></details>
      <div class="fd-runtime-alert-actions"><button class="btn sm primary" type="button" data-runtime-reload>Reload dashboard</button><button class="btn sm" type="button" data-runtime-copy>Copy diagnostic</button></div>`;
    runtimeAlert.hidden = false;
  }
  function reportRuntimeIssue(value) {
    const message = String(value || 'Unknown interface error')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    if (!message) return;
    if (runtimeIssue && runtimeIssue.message === message) runtimeIssue.count += 1;
    else runtimeIssue = { message, count: 1 };
    renderRuntimeAlert();
  }
  function installRuntimeGuard() {
    runtimeAlert = document.createElement('aside');
    runtimeAlert.id = 'fd-runtime-alert';
    runtimeAlert.hidden = true;
    runtimeAlert.setAttribute('role', 'alert');
    document.body.appendChild(runtimeAlert);
    runtimeAlert.addEventListener('click', async e => {
      if (e.target.closest('[data-runtime-dismiss]')) {
        runtimeAlert.hidden = true;
        return;
      }
      if (e.target.closest('[data-runtime-reload]')) {
        location.reload();
        return;
      }
      if (e.target.closest('[data-runtime-copy]') && runtimeIssue) {
        try {
          await navigator.clipboard.writeText(
            `Domain Fleet Manager UI error: ${runtimeIssue.message}`
          );
          runtimeNotice('Diagnostic copied');
        } catch {
          runtimeNotice('Could not copy diagnostic', 'err');
        }
      }
    });
    addEventListener('error', e => reportRuntimeIssue(e.error?.message || e.message));
    addEventListener('unhandledrejection', e => reportRuntimeIssue(e.reason?.message || e.reason));
  }

  /* ---------------------------------------------------------- 1. VITALS -- */
  const railHTML = `
    <div class="vt" data-vt="sites" data-vt-action="control" role="button" tabindex="0" aria-label="Open all fleet sites" style="--vt-c:var(--a1)"><div class="vt-k">Fleet</div><div class="vt-v">—</div><div class="vt-sub">sites discovered</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="fresh" data-vt-action="control?filter=fresh" role="button" tabindex="0" aria-label="Show sites with fresh roles" style="--vt-c:var(--green)"><div class="vt-k">Roles fresh</div><div class="vt-v">—</div><div class="vt-sub">ran within window</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="attention" data-vt-action="control?filter=attention" role="button" tabindex="0" aria-label="Show sites needing role attention" style="--vt-c:var(--yellow)"><div class="vt-k">Needs attention</div><div class="vt-v">—</div><div class="vt-sub">stale or overdue roles</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="paused" data-vt-action="control?filter=paused" role="button" tabindex="0" aria-label="Show sites with paused roles" style="--vt-c:var(--purple)"><div class="vt-k">Paused</div><div class="vt-v">—</div><div class="vt-sub">disabled by flag</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="containers" data-vt-action="containers" role="button" tabindex="0" aria-label="Open container status" style="--vt-c:var(--a3)"><div class="vt-k">Containers</div><div class="vt-v">—</div><div class="vt-sub">running</div><div class="vt-bars"></div></div>
    <div class="vt" data-vt="health" data-vt-action="control?sort=health" role="button" tabindex="0" aria-label="Show worst role health first" style="--vt-c:var(--green)"><div class="vt-k">Fleet role health</div><div class="vt-v">—</div><div class="vt-sub">scheduled-role freshness</div><div class="vt-meter"><i></i></div></div>`;

  const rail = document.createElement('section');
  rail.id = 'vitals';
  rail.className = 'hidden';
  rail.setAttribute('aria-label', 'Fleet vitals');
  // This strip is injected once above <main> and stays fixed across every
  // view (Domain Control, Social Hub, Containers, ...) — it is NEVER scoped
  // to the page underneath it. Without a label that reads as "whatever page
  // I'm on", which it isn't: it's fleet-wide cron-role + container state from
  // /api/roles and /api/containers, full stop.
  rail.innerHTML = `<div class="vt-scope">Fleet-wide — every site, every role</div>` + railHTML;

  const cell = k => $(`.vt[data-vt="${k}"]`, rail);
  const setVal = (k, v, sub) => {
    const c = cell(k);
    if (!c) return;
    const el = $('.vt-v', c);
    if (el.innerHTML !== v) {
      el.innerHTML = v;
      if (!reduce) {
        el.animate(
          [
            { opacity: 0.35, transform: 'translateY(4px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 280, easing: 'cubic-bezier(.16,1,.3,1)' }
        );
      }
    }
    if (sub != null) $('.vt-sub', c).textContent = sub;
  };
  const setMeter = (k, pct) => {
    const i = $('.vt-meter i', cell(k) || document.createElement('div'));
    if (i) i.style.width = Math.max(2, Math.min(100, pct)) + '%';
  };

  let vitalsTimer = null;
  function openVitalView(card) {
    const target = card?.dataset.vtAction;
    if (target) location.hash = `#${target}`;
  }
  rail.addEventListener('click', e => {
    const card = e.target.closest('.vt');
    if (card) openVitalView(card);
  });
  rail.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.vt')) {
      e.preventDefault();
      openVitalView(e.target.closest('.vt'));
    }
  });
  function closeHealthDetails() {
    const details = document.querySelector('#fleet-health-details');
    const trigger = document.querySelector('#fleet-health-trigger');
    if (details) details.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function renderHealthPulse({
    fresh,
    live,
    stale,
    overdue,
    healthPct,
    runningAll,
    containerTotal,
    unhealthyAll,
  }) {
    const foot = document.querySelector('#rail .rl-foot');
    if (!foot) return;
    const tone = healthPct >= 90 ? 'ok' : healthPct >= 70 ? 'warn' : 'bad';
    const containerSummary = unhealthyAll
      ? `${unhealthyAll} unhealthy container${unhealthyAll === 1 ? '' : 's'}`
      : `${runningAll}/${containerTotal} containers healthy`;
    foot.innerHTML = `
      <div class="rl-health-wrap">
        <button id="fleet-health-trigger" class="rl-pulse ${tone}" type="button" aria-expanded="false" aria-controls="fleet-health-details" title="Show why fleet health is ${healthPct}%">
          <span class="rl-pulse-dot" aria-hidden="true"></span>
          <span class="rl-pulse-t">Fleet health</span>
          <span class="rl-pulse-v">${healthPct}%</span>
        </button>
        <div id="fleet-health-details" class="rl-health-details" role="status" hidden>
          <strong>Why ${healthPct}%?</strong>
          <span>${fresh}/${live} active scheduled roles are fresh.</span>
          <span>${overdue} overdue · ${stale} stale role${overdue + stale === 1 ? '' : 's'}.</span>
          <span>${containerSummary}.</span>
          <small>Warning begins below 90%.</small>
          <a href="#health" data-health-details-link>Open Health view →</a>
        </div>
      </div>`;
  }

  document.addEventListener('click', e => {
    const trigger = e.target.closest('#fleet-health-trigger');
    if (trigger) {
      const details = document.querySelector('#fleet-health-details');
      const open = details && details.hidden;
      if (details) details.hidden = !open;
      trigger.setAttribute('aria-expanded', String(Boolean(open)));
      return;
    }
    if (e.target.closest('[data-health-details-link]')) {
      closeHealthDetails();
      return;
    }
    if (!e.target.closest('.rl-health-wrap')) closeHealthDetails();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeHealthDetails();
  });

  async function loadVitals() {
    try {
      const controlView = document.body.dataset.view === 'control';
      const rolesPromise = controlView
        ? typeof globalThis.fleetLoadRoleMatrix === 'function'
          ? globalThis.fleetLoadRoleMatrix()
          : fetch('/api/roles', { credentials: 'same-origin' }).then(r => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.json();
            })
        : typeof globalThis.fleetLoadRoleVitals === 'function'
          ? globalThis.fleetLoadRoleVitals()
          : fetch('/api/roles/vitals', { credentials: 'same-origin' }).then(r => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.json();
            });
      const containersPromise =
        typeof globalThis.fleetLoadContainers === 'function'
          ? globalThis.fleetLoadContainers()
          : fetch('/api/containers', { credentials: 'same-origin' }).then(r => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.json();
            });
      const [roles, containers] = await Promise.all([
        rolesPromise,
        containersPromise,
      ]);
      if (!Array.isArray(containers)) {
        rail.classList.add('hidden');
        return;
      }
      const allCts = containers;
      // The containers tile is the one cell that gets scoped to whatever page
      // it's sitting above: on Social Hub it has no business showing the
      // fleet's 70+ containers (dev sandboxes, every site's crons, ...) when
      // Social Hub itself runs as a single container (social-hub-api). Every
      // other view keeps the fleet-wide list.
      const socialScoped = document.body.dataset.view === 'socialhub';
      const cts = socialScoped ? allCts.filter(c => /social-hub/i.test(c.name || '')) : allCts;

      const matrix = Array.isArray(roles.sites);
      let fresh = matrix ? 0 : roles.fresh,
        stale = matrix ? 0 : roles.stale,
        overdue = matrix ? 0 : roles.overdue,
        paused = matrix ? 0 : roles.paused,
        total = matrix ? 0 : roles.total;
      const siteCount = matrix ? roles.sites.length : roles.siteCount;
      const roleCount = matrix ? roles.roles.length : roles.roleCount;
      if (matrix) {
        for (const s of roles.sites) {
          for (const c of Object.values(s.cells || {})) {
            if (!c || !c.scheduled) continue;
            total++;
            if (c.enabled === false) {
              paused++;
              continue;
            }
            if (c.state === 'fresh') fresh++;
            else if (c.state === 'stale') stale++;
            else if (c.state === 'overdue') overdue++;
          }
        }
      }
      const live = total - paused || 1;
      // Fleet-wide, regardless of the containers tile's scoping below — the
      // health tile and the nav-rail foot mirror both describe the WHOLE
      // fleet and must never quietly narrow to whatever page is showing.
      const runningAll = allCts.filter(c => c.running).length;
      const unhealthyAll = allCts.filter(c => c.unhealthy).length;
      const running = cts.filter(c => c.running).length;
      const unhealthy = cts.filter(c => c.unhealthy).length;
      const healthPct = Math.round((fresh / live) * 100);

      setVal(
        'sites',
        String(siteCount),
        `${roleCount} distinct roles`
      );
      setMeter('sites', 100);

      setVal('fresh', `${fresh}<small>/${live}</small>`, 'ran within window');
      setMeter('fresh', (fresh / live) * 100);

      const att = stale + overdue;
      const attCell = cell('attention');
      if (attCell)
        attCell.style.setProperty(
          '--vt-c',
          overdue ? 'var(--red)' : att ? 'var(--yellow)' : 'var(--green)'
        );
      setVal(
        'attention',
        String(att),
        overdue ? `${overdue} overdue · ${stale} stale` : `${stale} stale`
      );
      setMeter('attention', (att / live) * 100);

      setVal('paused', String(paused), 'disabled by flag');
      setMeter('paused', (paused / (total || 1)) * 100);

      const ctsLabel = cell('containers') && $('.vt-k', cell('containers'));
      if (ctsLabel) ctsLabel.textContent = socialScoped ? 'Social Hub container' : 'Containers';
      setVal(
        'containers',
        `${running}<small>/${cts.length}</small>`,
        socialScoped
          ? cts.length
            ? unhealthy
              ? `${unhealthy} unhealthy`
              : 'all healthy'
            : 'not running'
          : unhealthy
            ? `${unhealthy} unhealthy`
            : 'all healthy'
      );
      const bars = $('.vt-bars', cell('containers'));
      if (bars) {
        const slice = cts.slice(0, 26);
        bars.innerHTML = slice.map(() => '<i></i>').join('');
        $$('i', bars).forEach((b, i) => {
          const c = slice[i];
          b.style.height = (c.running ? (c.unhealthy ? 45 : 100) : 22) + '%';
          b.style.background = c.unhealthy
            ? 'var(--red)'
            : c.running
              ? 'var(--a3)'
              : 'var(--faint)';
          b.title = `${c.name} — ${c.status}`;
        });
      }

      const hCell = cell('health');
      if (hCell)
        hCell.style.setProperty(
          '--vt-c',
          healthPct >= 90 ? 'var(--green)' : healthPct >= 70 ? 'var(--yellow)' : 'var(--red)'
        );
      setVal(
        'health',
        `${healthPct}<small>%</small>`,
        unhealthyAll ? 'container degradation' : 'weighted uptime'
      );
      setMeter('health', healthPct);

      rail.classList.remove('hidden');

      // compact mirror in the nav rail's foot, so health is on screen even
      // when you've scrolled the vitals off the top — always fleet-wide.
      renderHealthPulse({
        fresh,
        live,
        stale,
        overdue,
        healthPct,
        runningAll,
        containerTotal: allCts.length,
        unhealthyAll,
      });
    } catch {
      rail.classList.add('hidden');
    }
  }

  /* -------------------------------------------------- 2. COMMAND PALETTE -- */
  const palette = document.createElement('div');
  palette.id = 'cmdk';
  palette.className = 'hidden';
  palette.innerHTML = `
    <div class="cmdk-card" role="dialog" aria-modal="true" aria-label="Command palette">
      <input id="cmdk-input" type="text" placeholder="Jump to a view, an agent, a site…" aria-label="Search commands" aria-controls="cmdk-list" aria-autocomplete="list" spellcheck="false" autocomplete="off" />
      <div id="cmdk-list" class="cmdk-list" role="listbox" aria-label="Commands"></div>
      <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
    </div>`;

  const pInput = $('input', palette),
    pList = $('.cmdk-list', palette);
  const RECENT_KEY = 'fd.command-recent.v1';
  let items = [],
    sel = 0,
    restoreFocus = null;

  function readRecent() {
    try {
      const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(value)
        ? value
            .filter(row => row && typeof row.label === 'string' && typeof row.group === 'string')
            .slice(0, 8)
        : [];
    } catch {
      return [];
    }
  }

  function rememberCommand(item) {
    if (!item?.label || !item?.group) return;
    const next = [
      { label: item.label, group: item.group },
      ...readRecent().filter(row => row.label !== item.label || row.group !== item.group),
    ].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {}
  }

  function clearRecentCommands() {
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {}
    announce('Recent commands cleared');
  }

  /* Commands are harvested from the live nav, so the palette never drifts out
     of sync with whatever tabs/agents the server advertises. */
  function harvest() {
    const out = [];
    $$('.tabs .tab[data-view]').forEach(b =>
      out.push({ label: b.textContent.trim(), group: 'view', ico: '◈', run: () => b.click() })
    );
    $$('.tabs .dd-menu .dd-item').forEach(d => {
      const grpBtn = d.closest('.tab-dd')?.querySelector('.tab-dd-btn');
      const group = (grpBtn?.textContent || '').replace('▾', '').trim().toLowerCase() || 'go';
      // strip the trailing count chip so "Engineer26" doesn't become the label
      const c = d.cloneNode(true);
      c.querySelectorAll('.dd-count').forEach(n => n.remove());
      const label = c.textContent.trim();
      out.push({
        label,
        group,
        ico: group === 'agents' ? '◉' : '◇',
        run: () => {
          d.click();
          $$('.dd-menu').forEach(m => m.classList.add('hidden'));
        },
      });
    });
    // The rail owns the personalized Favorites order. Harvest those live
    // buttons instead of duplicating favorite route metadata in the palette.
    $$('.rl-sec[data-sec="favorites"] .rl-it').forEach(button => {
      const label = $('.rl-t', button)?.textContent?.trim();
      if (label) out.push({ label, group: 'favorites', ico: '★', run: () => button.click() });
    });
    out.push({
      label: 'Refresh now',
      group: 'action',
      ico: '↻',
      run: () => $('#refresh')?.click(),
    });
    out.push({
      label: 'Toggle auto-refresh',
      group: 'action',
      ico: '⟳',
      run: () => $('#auto-on')?.click(),
    });
    out.push({
      label: 'Filter sites…',
      group: 'action',
      ico: '⌕',
      run: () => setTimeout(() => $('#fleet-filter')?.focus(), 60),
    });
    if ($('#fleet-filter')?.value) {
      out.push({
        label: 'Clear site filter',
        group: 'action',
        ico: '×',
        run: () => $('#fleet-filter-clear')?.click(),
      });
    }
    out.push({
      label: 'Copy current link',
      group: 'action',
      ico: '↗',
      run: copyCurrentLink,
    });
    out.push({
      label: 'Keyboard shortcuts',
      group: 'help',
      ico: '?',
      run: openShortcutHelp,
    });
    if (readRecent().length) {
      out.push({
        label: 'Clear recent commands',
        group: 'action',
        ico: '×',
        skipRecent: true,
        run: clearRecentCommands,
      });
    }
    out.push({
      label: document.body.classList.contains('fd-focus-mode')
        ? 'Exit focus mode'
        : 'Enter focus mode',
      group: 'action',
      ico: '◌',
      run: toggleFocusMode,
    });
    const recent = readRecent()
      .map(row => out.find(item => item.label === row.label && item.group === row.group))
      .filter(Boolean)
      .map(item => ({ ...item, group: 'recent', recentGroup: item.group, ico: '↶' }));
    const recentLabels = new Set(recent.map(item => item.label));
    const seen = new Set();
    return [...recent, ...out.filter(item => !recentLabels.has(item.label))].filter(
      item => item.label && !seen.has(item.group + item.label) && seen.add(item.group + item.label)
    );
  }

  const score = (label, q) => {
    const l = label.toLowerCase();
    if (!q) return 1;
    if (l.startsWith(q)) return 100;
    if (l.includes(q)) return 60;
    let i = 0;
    for (const ch of l) if (ch === q[i]) i++; // subsequence
    return i === q.length ? 20 : 0;
  };

  function draw() {
    const q = pInput.value.trim().toLowerCase();
    items = harvest()
      .map(i => ({ ...i, s: score(i.label, q) }))
      .filter(i => i.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40);
    sel = 0;
    pList.innerHTML = items.length
      ? items
          .map(
            (i, n) =>
              `<div class="cmdk-row${n === 0 ? ' sel' : ''}" data-n="${n}" role="option" aria-selected="${n === 0 ? 'true' : 'false'}" aria-posinset="${n + 1}" aria-setsize="${items.length}" id="cmdk-option-${n}"><span class="cmdk-ico">${esc(i.ico)}</span><span></span><span class="cmdk-grp">${esc(i.group)}</span></div>`
          )
          .join('')
      : '<div class="cmdk-empty">Nothing matches that.</div>';
    $$('.cmdk-row', pList).forEach((r, n) => {
      r.children[1].textContent = items[n].label;
      r.onmouseenter = () => mark(n);
      r.onclick = () => fire(n);
    });
    if (items.length) pInput.setAttribute('aria-activedescendant', 'cmdk-option-0');
    else pInput.removeAttribute('aria-activedescendant');
  }
  function mark(n) {
    if (!items.length) return;
    sel = (n + items.length) % items.length;
    $$('.cmdk-row', pList).forEach((r, i) => {
      const selected = i === sel;
      r.classList.toggle('sel', selected);
      r.setAttribute('aria-selected', String(selected));
    });
    pInput.setAttribute('aria-activedescendant', `cmdk-option-${sel}`);
    $$('.cmdk-row', pList)[sel]?.scrollIntoView({ block: 'nearest' });
  }
  function fire(n) {
    const it = items[n];
    close();
    if (it) {
      if (!it.skipRecent) rememberCommand({ label: it.label, group: it.recentGroup || it.group });
      setTimeout(it.run, 10);
    }
  }
  function open() {
    restoreFocus =
      document.activeElement && typeof document.activeElement.focus === 'function'
        ? document.activeElement
        : null;
    palette.classList.remove('hidden');
    pInput.value = '';
    draw();
    pInput.removeAttribute('aria-activedescendant');
    pInput.focus();
  }
  function close() {
    palette.classList.add('hidden');
    restoreFocus?.focus?.();
    restoreFocus = null;
  }

  let shortcutRestoreFocus = null;
  const shortcutHelp = document.createElement('div');
  shortcutHelp.id = 'fd-shortcuts';
  shortcutHelp.className = 'hidden';
  shortcutHelp.innerHTML = `
    <div class="fd-shortcuts-card" role="dialog" aria-modal="true" aria-labelledby="fd-shortcuts-title">
      <div class="fd-shortcuts-head"><div><span class="fd-shortcuts-kicker">COMMAND DECK</span><h2 id="fd-shortcuts-title">Keyboard shortcuts</h2></div><button class="icon-btn" type="button" data-shortcuts-close aria-label="Close keyboard shortcuts">×</button></div>
      <div class="fd-shortcuts-grid">
        <div><kbd>⌘</kbd><kbd>K</kbd><span>Open command palette</span></div>
        <div><kbd>/</kbd><span>Focus site filter</span></div>
        <div><kbd>?</kbd><span>Open command palette</span></div>
        <div><kbd>⌘</kbd><kbd>⇧</kbd><kbd>F</kbd><span>Toggle focus mode</span></div>
        <div><kbd>⌘</kbd><kbd>[</kbd><span>Fold or expand navigation</span></div>
        <div><kbd>Esc</kbd><span>Close the active surface</span></div>
      </div>
      <p class="muted fd-shortcuts-note">Use the command palette to jump to views, agents, favorites, and saved actions.</p>
    </div>`;
  shortcutHelp.addEventListener('click', event => {
    if (event.target === shortcutHelp || event.target.closest('[data-shortcuts-close]'))
      closeShortcutHelp();
  });
  function openShortcutHelp() {
    close();
    shortcutRestoreFocus = document.activeElement;
    shortcutHelp.classList.remove('hidden');
    shortcutHelp.querySelector('[data-shortcuts-close]')?.focus();
  }
  function closeShortcutHelp() {
    shortcutHelp.classList.add('hidden');
    if (shortcutRestoreFocus?.isConnected) shortcutRestoreFocus.focus();
    shortcutRestoreFocus = null;
  }
  addEventListener('keydown', event => {
    if (event.key === 'Escape' && !shortcutHelp.classList.contains('hidden')) {
      event.preventDefault();
      closeShortcutHelp();
    }
  });

  function announce(message, kind = 'ok') {
    if (typeof globalThis.fleetToast === 'function') {
      globalThis.fleetToast(message, kind);
      return;
    }
    const toast = $('#toast');
    if (!toast) return;
    const messageEl = $('#toast-message', toast);
    if (messageEl) messageEl.textContent = message;
    else toast.textContent = message;
    toast.className = `toast show ${kind}`;
    clearTimeout(announce.timer);
    announce.timer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  async function copyCurrentLink() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(location.href);
      } else {
        const area = document.createElement('textarea');
        area.value = location.href;
        area.setAttribute('readonly', '');
        area.setAttribute('aria-hidden', 'true');
        area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand?.('copy');
        area.remove();
        if (!copied) throw new Error('copy unavailable');
      }
      announce('Current view link copied');
    } catch {
      announce('Could not copy the current link', 'err');
    }
  }

  const FOCUS_KEY = 'fd.focus-mode';
  function applyFocusMode(on) {
    document.body.classList.toggle('fd-focus-mode', on);
    const button = $('.focus-mode-toggle');
    if (button) {
      button.textContent = on ? 'Exit focus' : 'Focus';
      button.title = on
        ? 'Show fleet vitals again (⌘⇧F)'
        : 'Hide fleet vitals for a focused workspace (⌘⇧F)';
      button.setAttribute('aria-pressed', String(on));
    }
    try {
      localStorage.setItem(FOCUS_KEY, on ? '1' : '0');
    } catch {}
  }
  function toggleFocusMode() {
    applyFocusMode(!document.body.classList.contains('fd-focus-mode'));
  }

  pInput.addEventListener('input', draw);
  palette.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  palette.addEventListener('mousedown', e => {
    if (e.target === palette) close();
  });
  pInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mark(sel + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mark(sel - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      mark(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      mark(items.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      fire(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.classList.contains('hidden') ? open() : close();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleFocusMode();
    }
    if (
      e.key === '/' &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) &&
      !e.target.isContentEditable
    ) {
      e.preventDefault();
      $('#fleet-filter')?.focus();
    }
    if (
      e.key === '?' &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) &&
      !e.target.isContentEditable
    ) {
      e.preventDefault();
      palette.classList.contains('hidden') ? open() : close();
    }
  });

  /* -------------------------------------------------------- 3. MOTION ---- */
  // view entrance: fires only when the route actually changes, so in-place
  // auto-refreshes (app.js softRender) never flash.
  function watchView() {
    const main = $('#app');
    if (!main) return;
    let last = document.body.dataset.view;
    new MutationObserver(() => {
      const v = document.body.dataset.view;
      if (v === last) return;
      const enteringOrLeavingSocial = v === 'socialhub' || last === 'socialhub';
      const enteringOrLeavingControl = v === 'control' || last === 'control';
      last = v;
      // The containers tile scopes to Social Hub — refetch immediately on
      // entering/leaving it instead of waiting up to 30s for the next poll.
      if (enteringOrLeavingSocial || enteringOrLeavingControl) loadVitals();
      if (reduce) return;
      main.classList.remove('view-enter');
      void main.offsetWidth;
      main.classList.add('view-enter');
      setTimeout(() => main.classList.remove('view-enter'), 700);
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    const syncBusy = () =>
      main.setAttribute('aria-busy', String(Boolean(main.querySelector('.loading'))));
    syncBusy();
    new MutationObserver(syncBusy).observe(main, { childList: true, subtree: true });
  }

  function installBackTop() {
    if ($('#fd-back-top')) return;
    const button = document.createElement('button');
    button.id = 'fd-back-top';
    button.type = 'button';
    button.setAttribute('aria-label', 'Back to top');
    button.title = 'Back to top';
    button.innerHTML = '<span aria-hidden="true">↑</span><small>Top</small>';
    const sync = () => button.classList.toggle('is-visible', scrollY > 420);
    button.addEventListener('click', () =>
      scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    );
    addEventListener('scroll', sync, { passive: true });
    sync();
    document.body.appendChild(button);
  }

  function installNetworkStatus() {
    const actions = $('.actions');
    if (!actions || $('.fd-network-status', actions)) return;
    const status = document.createElement('span');
    status.className = 'fd-network-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    actions.insertBefore(status, actions.firstChild);
    let onlineTimer = null;
    let refreshTimer = null;
    const render = online => {
      clearTimeout(onlineTimer);
      status.classList.toggle('is-offline', !online);
      status.hidden = online;
      status.textContent = online ? 'Back online' : 'Offline — refresh paused';
      status.title = online
        ? 'Network connection restored. The next refresh will reconcile this view.'
        : 'The browser is offline. Automatic refreshes may be stale until the connection returns.';
      if (online)
        onlineTimer = setTimeout(() => {
          status.hidden = true;
        }, 4200);
    };
    const initialOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
    render(initialOnline);
    addEventListener('offline', () => {
      render(false);
      announce('Offline: automatic refresh may be stale', 'err');
    });
    addEventListener('online', () => {
      render(true);
      announce('Connection restored; refreshing shortly');
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => $('#refresh')?.click(), 450);
    });
  }

  function installModalFocusManager() {
    const focusable = root =>
      $$(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        root
      ).filter(
        el =>
          !el.hidden &&
          el.getAttribute('aria-hidden') !== 'true' &&
          (el.offsetWidth || el.offsetHeight || el === document.activeElement)
      );
    let activeModal = null;
    let previousFocus = null;
    const currentModal = () =>
      $(
        '.modal:not(.hidden), .login-overlay:not(.hidden), .err-drawer-shell:not(.hidden), .ex-run-drawer-shell:not(.hidden), #cmdk:not(.hidden), #fd-shortcuts:not(.hidden)'
      );
    const sync = () => {
      const next = currentModal();
      if (next === activeModal) return;
      if (next) {
        previousFocus = document.activeElement;
        activeModal = next;
        requestAnimationFrame(() => {
          const first = $('[autofocus]', next) || focusable(next)[0];
          first?.focus?.();
        });
      } else if (activeModal) {
        const restore = previousFocus;
        activeModal = null;
        previousFocus = null;
        if (restore?.isConnected) requestAnimationFrame(() => restore.focus?.());
      }
    };
    new MutationObserver(sync).observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    addEventListener(
      'keydown',
      e => {
        if (!activeModal || e.key !== 'Tab') return;
        const list = focusable(activeModal);
        if (!list.length) {
          e.preventDefault();
          activeModal.focus?.();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      },
      true
    );
    sync();
  }

  // ripple on every button, present or future (delegated).
  addEventListener(
    'pointerdown',
    e => {
      if (reduce) return;
      const b = e.target.closest('.btn');
      if (!b || b.disabled) return;
      const r = b.getBoundingClientRect(),
        d = Math.max(r.width, r.height);
      const s = document.createElement('span');
      s.className = 'ripple';
      s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
      b.appendChild(s);
      setTimeout(() => s.remove(), 520);
    },
    { passive: true }
  );

  /* ----------------------------------------------------------- 4. BOOT --- */
  function boot() {
    const main = $('#app');
    if (main && !$('#vitals')) main.parentNode.insertBefore(rail, main);
    if (!$('#cmdk')) document.body.appendChild(palette);
    if (!$('#fd-shortcuts')) document.body.appendChild(shortcutHelp);
    if (!$('#fd-runtime-alert')) installRuntimeGuard();
    installBackTop();
    installNetworkStatus();
    installModalFocusManager();

    // ⌘K affordance in the topbar
    const actions = $('.actions');
    if (actions && !$('.cmdk-hint')) {
      const hint = document.createElement('button');
      hint.className = 'cmdk-hint';
      hint.type = 'button';
      hint.title = 'Command palette (⌘K, ?, or /)';
      hint.innerHTML = `<span>⌘</span><kbd>K</kbd>`;
      hint.onclick = open;
      actions.insertBefore(hint, actions.firstChild);
    }
    if (actions && !$('.focus-mode-toggle')) {
      const focus = document.createElement('button');
      focus.className = 'btn sm focus-mode-toggle';
      focus.type = 'button';
      focus.onclick = toggleFocusMode;
      actions.insertBefore(focus, actions.firstChild);
    }
    let focusOn = false;
    try {
      focusOn = localStorage.getItem(FOCUS_KEY) === '1';
    } catch {}
    applyFocusMode(focusOn);

    watchView();
    loadVitals();
    clearInterval(vitalsTimer);
    vitalsTimer = setInterval(() => {
      if (!document.hidden) loadVitals();
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadVitals();
    });
  }

  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', boot) : boot();
})();

/* ============================================================================
   shell.js — part 2: the navigation rail
   ----------------------------------------------------------------------------
   Replaces the topbar's dropdown bar with a persistent, grouped sidebar.

   It is a PROJECTION of the nav app.js already builds, never a fork of it:
   every rail item is bound to a real `.tab[data-view]` / `.dd-item` node and
   navigates by clicking it, and active state is read back off those same nodes
   after each render. So app.js stays the single source of truth for routes,
   groups and the agent roster — add a view there and it shows up here for
   free, with no second list to keep in sync.
   ========================================================================== */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const LS = 'fd.rail';
  const esc = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  /* 24px stroke icons, keyed by view. Anything unmapped falls back to a dot,
     so a new view never renders broken. */
  const P = {
    control: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    cron: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2',
    containers: 'M12 2.8 20.5 7v10L12 21.2 3.5 17V7zM3.5 7 12 11.4 20.5 7M12 11.4V21',
    git: 'M6 4v9a3 3 0 0 0 3 3h6M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 8v2a3 3 0 0 1-3 3h-3',
    githygiene: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.2l2.4 2.4 4.6-5',
    tasks:
      'M4 6.5 5.6 8 8.5 5M4 12.5 5.6 14l2.9-3M4 18.5 5.6 20l2.9-3M11.5 6.5H20M11.5 12.5H20M11.5 18.5H20',
    deploys:
      'M12 15V3.5M12 3.5 8 7.5M12 3.5l4 4M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15',
    builds:
      'M4 19.5h16M6.5 16.5l4.2-4.2M9.2 5.2l3.7 3.7M8 4l1.2 1.2-4.7 4.7a2.6 2.6 0 0 0 3.7 3.7l4.7-4.7 1.2 1.2M14.2 14.2l5.3 5.3',
    domains:
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.2 9h17.6M3.2 15h17.6M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
    guardrails: 'M12 2.8 20 6v6.2c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6zM9 12l2.2 2.2L15.5 10',
    doctor:
      'M8 3.5v5a4 4 0 0 0 8 0v-5M6 3.5h4M14 3.5h4M12 12.5v2.2a4.3 4.3 0 0 0 8.6 0v-1.2M19 11.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
    retention: 'M4 7.5h16v12H4zM3 4h18v3.5H3zM9 11.5h6M12 15v-3.5',
    guides:
      'M4 4.5h6a2.5 2.5 0 0 1 2 2.5v13a2 2 0 0 0-2-1.6H4zM20 4.5h-6a2.5 2.5 0 0 0-2 2.5v13a2 2 0 0 1 2-1.6h6z',
    productfeed:
      'M11.5 3.2 20 11.7a1.8 1.8 0 0 1 0 2.5l-5.8 5.8a1.8 1.8 0 0 1-2.5 0L3.2 11.5V3.2zM7.6 7.6h.01',
    datahub:
      'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    datahubimages: 'M3.5 5.5h17v13h-17zM3.5 15l4.5-4.2 3.4 3.2 3.6-3.9 5.5 5.4M8.4 9.4h.01',
    sitefacts:
      'M13.5 3.2H6.5A1.5 1.5 0 0 0 5 4.7v14.6a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8.7zM13.5 3.2V8.7H19M8.5 13h7M8.5 16.5h4.5',
    seointelligence: 'M10.5 18a7.5 7.5 0 1 1 5.3-2.2L21 21M7.5 12l2.6-2.7 2.1 2.1 3.5-4',
    analytics: 'M4 20V13M9.3 20V7M14.7 20v-8.5M20 20V4',
    social:
      'M17 8.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM6.5 15.1a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM17 21.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM8.8 11.3l5.9-2.7M8.8 13.9l5.9 2.7',
    socialhub:
      'M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l5.5 4V5L8 9H5.5A1.5 1.5 0 0 0 4 10.5zM17.2 8.6a5 5 0 0 1 0 6.8M19.8 6a8.5 8.5 0 0 1 0 12',
    automation: 'M13.3 2.5 4 13.8h6.4l-.7 7.7L19 10.2h-6.4z',
    aiusage: 'M3.5 12a8.5 8.5 0 0 1 17 0M12 12l4-3.4M12 19.5v.01',
    aioptimizer:
      'M5 20v-6M5 10V4M12 20v-9M12 7V4M19 20v-3M19 13V4M2.6 14h4.8M9.6 7h4.8M16.6 17h4.8',
    aiinventory: 'M12 2.8 21 7.4l-9 4.6-9-4.6zM3 12.2l9 4.6 9-4.6M3 16.8l9 4.6 9-4.6',
    taskbudget:
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v10M14.6 9.4a2.6 2.6 0 0 0-2.6-1.4h-.4a2.1 2.1 0 0 0-.4 4.1l2 .4a2.1 2.1 0 0 1-.4 4.1H12a2.6 2.6 0 0 1-2.6-1.4',
    compliance: 'M12 2.8 20 6v6.2c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6zM9.2 11.9l2.1 2.1 3.9-4.2',
    lint: 'M8.5 6.5a3.5 3.5 0 1 1 7 0M5.5 11.5h13M6.5 9.5v4.5a5.5 5.5 0 0 0 11 0V9.5zM3.5 9l2.5 1M20.5 9 18 10M3.5 17.5 6 16.4M20.5 17.5 18 16.4M12 14.5v6',
    health: 'M3 12.5h4l2-4.5 3 9 2.5-6 1.6 3h4.9',
    errors:
      'M10.6 4.1 2.9 17.2a1.6 1.6 0 0 0 1.4 2.4h15.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4.1a1.6 1.6 0 0 0-2.8 0zM12 9.5v4M12 17h.01',
    activity: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM7.6 12.4h2.2l1.4-3.4 1.9 6 1.3-2.6h2',
    devsandbox: 'M3.5 5.5h17v13h-17zM7.2 10l2.4 2.2-2.4 2.2M12.4 15h4.2',
    dataquality:
      'M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3zM4 6v12c0 1.7 3.6 3 8 3 1.1 0 2.2-.1 3.1-.3M4 12c0 1.7 3.6 3 8 3M16 17.5l1.6 1.6 3-3.2',
    agent: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z',
  };
  const GRP = {
    agents: 'agent',
    ops: 'cron',
    content: 'guides',
    growth: 'analytics',
    quality: 'compliance',
  };
  const icon = k =>
    P[k]
      ? `<svg class="rl-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${P[k]}"/></svg>`
      : `<svg class="rl-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3.4"/></svg>`;

  // Agents are discovered from the fleet, so keep the visual vocabulary here
  // and provide keyword fallbacks for new/custom roles.
  const ROLE_EMOJI = {
    executive: '🧠',
    'product-manager-fleet': '🧰',
    'product-manager-sites': '🗂️',
    engineer: '🛠️',
    'principal-engineer': '🧭',
    'content-writer': '✍️',
    'news-writer': '📰',
    'guide-writer': '📚',
    'guide-idea-seeder': '💡',
    'guide-publisher': '📖',
    'seo-analyst': '🔎',
    'affiliate-editor': '🛍️',
    deployer: '🚀',
    watchdog: '🐕',
    maintainer: '🔧',
    planner: '🗺️',
    'social-poster': '📣',
    promoter: '📢',
  };
  const roleEmoji = role => {
    const key = String(role || '').toLowerCase();
    if (ROLE_EMOJI[key]) return ROLE_EMOJI[key];
    if (key.includes('write')) return '✍️';
    if (key.includes('seo') || key.includes('search')) return '🔎';
    if (key.includes('social') || key.includes('promo')) return '📣';
    if (key.includes('deploy') || key.includes('release')) return '🚀';
    if (key.includes('engineer') || key.includes('code')) return '🛠️';
    if (key.includes('audit') || key.includes('quality')) return '✅';
    return '🤖';
  };
  const agentIcon = role =>
    `<span class="rl-emoji" role="img" aria-label="${esc(String(role || 'agent'))}">${roleEmoji(role)}</span>`;

  // Category landing pages use the exact same icon vocabulary as the rail.
  // Exposing the pure renderer avoids maintaining a second icon map in app.js.
  globalThis.fleetNavIcon = icon;
  globalThis.fleetAgentIcon = agentIcon;

  const PREFS_VERSION = 1;
  const isPrefsObject = value => value && typeof value === 'object' && !Array.isArray(value);
  const uniqueFavoriteIds = value => [
    ...new Set(
      (Array.isArray(value) ? value : []).filter(id => typeof id === 'string' && id.length > 0)
    ),
  ];
  const normalizePrefs = value => {
    const next = isPrefsObject(value) ? { ...value } : {};
    next.schemaVersion = PREFS_VERSION;
    next.favorites = uniqueFavoriteIds(next.favorites);
    return next;
  };
  const readPrefs = raw => {
    try {
      return normalizePrefs(raw == null ? JSON.parse(localStorage.getItem(LS)) : raw);
    } catch {
      return normalizePrefs({});
    }
  };
  const prefs = readPrefs();
  const replacePrefs = next => {
    Object.keys(prefs).forEach(key => delete prefs[key]);
    Object.assign(prefs, normalizePrefs(next));
  };
  const save = () => {
    try {
      prefs.schemaVersion = PREFS_VERSION;
      prefs.favorites = uniqueFavoriteIds(prefs.favorites);
      localStorage.setItem(LS, JSON.stringify(prefs));
    } catch {}
  };
  addEventListener('storage', event => {
    if (event.key !== LS) return;
    let next = {};
    try {
      next = event.newValue == null ? {} : JSON.parse(event.newValue);
    } catch {}
    replacePrefs(next);
    sig = '';
    build();
  });

  const favoriteId = it => (it.role ? `agent:${it.role}` : `view:${it.key}`);
  const favoriteOrder = () => {
    const sourceSecs = sections();
    const rawSaved = Array.isArray(prefs.favorites) ? prefs.favorites : [];
    const saved = uniqueFavoriteIds(rawSaved);
    if (saved.length !== rawSaved.length) {
      prefs.favorites = saved;
      save();
    }
    // app.js boots asynchronously. shell.js runs immediately after the
    // script tag, so the first pass can happen while the grouped menus are
    // still empty. Do not interpret that temporary DOM shape as proof that
    // saved favorites are stale; otherwise the first build erases them from
    // localStorage before app.js has populated the navigation.
    const navReady = ['ops', 'content', 'growth', 'quality'].every(id =>
      sourceSecs.some(s => s.id === id && s.items.length)
    );
    if (!navReady) return saved;
    const agentsReady = sourceSecs.some(s => s.id === 'agents');
    const known = new Set(
      sourceSecs.flatMap(s => [...(s.root ? [s.root] : []), ...s.items].map(favoriteId))
    );
    // Agent entries are API-driven and the Agents menu is absent when that
    // request fails. Preserve those IDs until the menu has hydrated; a
    // transient API failure must not destroy a user's saved agent favorites.
    const valid = saved.filter(id => known.has(id) || (!agentsReady && id.startsWith('agent:')));
    if (valid.length !== saved.length) {
      prefs.favorites = valid;
      save();
    }
    return valid;
  };
  const favoriteLabel = id =>
    sections()
      .flatMap(s => [...(s.root ? [s.root] : []), ...s.items])
      .find(item => favoriteId(item) === id)?.label || 'Favorite';
  const restoreFavoriteFocus = (id, message) => {
    requestAnimationFrame(() => {
      const target = $(`[data-favorite-id="${CSS.escape(id)}"] .rl-it`, rail);
      target?.focus();
      if (message) globalThis.fleetToast?.(message);
    });
  };
  const setFavorite = (it, on) => {
    const id = favoriteId(it);
    const next = favoriteOrder().filter(x => x !== id);
    if (on) next.push(id);
    prefs.favorites = next;
    save();
    sig = '';
    build();
    restoreFavoriteFocus(id, `${it.label} ${on ? 'added to' : 'removed from'} Favorites`);
  };
  const moveFavorite = (id, offset) => {
    const next = favoriteOrder();
    const from = next.indexOf(id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    prefs.favorites = next;
    save();
    sig = '';
    build();
    restoreFavoriteFocus(id, `${favoriteLabel(id)} moved ${offset < 0 ? 'up' : 'down'}`);
  };

  const rail = document.createElement('aside');
  rail.id = 'rail';
  rail.innerHTML = `
    <div class="rl-top">
      <a class="rl-brand" title="Domain Control">
        <span class="rl-mark"></span>
        <span class="rl-word">Domain Fleet Manager</span>
      </a>
      <button class="rl-fold" type="button" title="Collapse sidebar" aria-label="Collapse sidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 7.5 10 12l4.5 4.5"/></svg>
      </button>
    </div>
    <nav class="rl-nav" aria-label="Primary"></nav>
    <div class="rl-foot"></div>`;

  /* ------------------------------------------------------------- build --- */
  // Reads the (now hidden) topbar nav and mirrors it into rail sections.
  function sections() {
    const out = [];
    const pinned = $$('.tabs > .tab[data-view]').map(el => ({
      key: el.dataset.view,
      label: el.textContent.trim(),
      el,
    }));
    if (pinned.length) out.push({ id: 'pinned', label: '', items: pinned, always: true });

    $$('.tabs .tab-dd').forEach(dd => {
      const btn = $('.tab-dd-btn', dd);
      const id = dd.dataset.group || (dd.id === 'agents-dd' ? 'agents' : '');
      if (!btn || !id) return;
      const items = $$('.dd-menu .dd-item', dd).map(el => {
        const c = el.cloneNode(true);
        c.querySelectorAll('.dd-count, .rl-emoji').forEach(n => n.remove());
        return {
          key: el.dataset.view || 'agent',
          role: el.dataset.role || '',
          label: c.textContent.trim(),
          count: $('.dd-count', el)?.textContent.trim() || '',
          el,
        };
      });
      if (items.length)
        out.push({
          id,
          label: btn.textContent.replace('▾', '').trim(),
          root: { key: id, label: btn.textContent.replace('▾', '').trim(), el: btn, root: true },
          items,
        });
    });
    return out;
  }

  let bound = new WeakMap();
  let sig = '';
  function build() {
    const nav = $('.rl-nav', rail);
    const sourceSecs = sections();
    if (!sourceSecs.length) return;
    const allItems = sourceSecs.flatMap(s => [...(s.root ? [s.root] : []), ...s.items]);
    const byFavorite = new Map(allItems.map(it => [favoriteId(it), it]));
    const favorites = favoriteOrder()
      .map(id => byFavorite.get(id))
      .filter(Boolean);
    const secs = [
      {
        id: 'favorites',
        label: 'Favorites',
        items: favorites,
        always: true,
        favoriteSection: true,
      },
      ...sourceSecs,
    ];

    // app.js repaints the agents/group menus on every render, which fires our
    // childList observer. Rebuilding then would wipe the rail mid-interaction:
    // scroll position lost, a collapse animation cut off, a just-toggled
    // section snapped back. So rebuild ONLY when the nav's shape actually
    // changed; otherwise just re-read active state.
    const next = secs
      .map(
        x => x.id + ':' + x.items.map(i => favoriteId(i) + '|' + i.label + '|' + i.count).join(',')
      )
      .join(';');
    if (next === sig) return sync();
    sig = next;
    const scroll = nav.scrollTop;

    nav.innerHTML = secs
      .map(s => {
        // Agents is 30+ entries — collapsed by default so the rail stays scannable.
        // User disclosure preferences remain authoritative, even for the active section.
        const dflt = s.id !== 'agents';
        const open = s.always || (prefs['s:' + s.id] ?? dflt);
        const root = s.root;
        const rootFavorite = root ? favoriteOrder().includes(favoriteId(root)) : false;
        const head = s.favoriteSection
          ? `<div class="rl-h rl-favorites-head"><div class="rl-h-main rl-favorites-label"><span class="rl-favorites-star" aria-hidden="true">★</span><span class="rl-h-t">Favorites</span><span class="rl-h-n">${s.items.length}</span></div><button class="rl-favorites-clear" type="button" data-favorites-clear ${s.items.length ? '' : 'disabled'} aria-label="Clear all favorites" title="Clear all favorites">Clear</button></div>`
          : s.always
            ? ''
            : `
        <div class="rl-h" data-sec="${s.id}">
          <button class="rl-h-main" type="button" data-root="${s.id}" title="Open ${esc(s.label)} overview">
            ${icon(GRP[s.id] || s.id)}
            <span class="rl-h-t">${esc(s.label)}</span>
            <span class="rl-h-n">${s.items.length}</span>
          </button>
          <button class="rl-root-fav" type="button" data-favorite-toggle="${esc(favoriteId(root))}" aria-pressed="${rootFavorite}" aria-label="${rootFavorite ? 'Remove' : 'Add'} ${esc(s.label)} ${rootFavorite ? 'from' : 'to'} favorites" title="${rootFavorite ? 'Remove from favorites' : 'Add to favorites'}">${rootFavorite ? '★' : '☆'}</button>
          <button class="rl-toggle" type="button" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(s.label)} navigation" title="${open ? 'Collapse' : 'Expand'} ${esc(s.label)} navigation">
            <svg class="rl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 10.5 12 14l3.5-3.5"/></svg>
          </button>
        </div>`;
        const isFavorites = s.favoriteSection;
        const items = s.items
          .map((it, n) => {
            const id = favoriteId(it);
            const isFav = favoriteOrder().includes(id);
            return `
        <div class="rl-fav-row" draggable="${isFavorites ? 'true' : 'false'}" data-favorite-id="${esc(id)}">
        <button class="rl-it" type="button" data-sec="${esc(s.id)}" data-n="${n}" title="${esc(it.label)}">
          ${it.root ? icon(GRP[it.key] || it.key) : s.id === 'agents' || it.role ? agentIcon(it.role || it.label) : icon(it.key)}
          <span class="rl-t">${esc(it.label)}</span>
          ${it.count ? `<span class="rl-n">${esc(it.count)}</span>` : ''}
        </button>
        <button class="rl-fav" type="button" data-favorite-toggle="${esc(id)}" aria-pressed="${isFav}" aria-label="${isFav ? 'Remove' : 'Add'} ${esc(it.label)} ${isFav ? 'from' : 'to'} favorites" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '★' : '☆'}</button>
        ${isFavorites ? `<span class="rl-fav-moves"><button class="rl-fav-move" type="button" data-favorite-move="-1" aria-label="Move ${esc(it.label)} up" title="Move up">↑</button><button class="rl-fav-move" type="button" data-favorite-move="1" aria-label="Move ${esc(it.label)} down" title="Move down">↓</button></span>` : ''}
        </div>`;
          })
          .join('');
        // items live in a SINGLE inner wrapper: the 0fr/1fr collapse only sizes
        // the grid's first row, so multiple direct children never collapse.
        return `<div class="rl-sec${open ? ' open' : ''}" data-sec="${esc(s.id)}">${head}<div class="rl-items"><div class="rl-items-in">${items}</div></div></div>`;
      })
      .join('');

    bound = new WeakMap();
    $$('.rl-sec', nav).forEach(secEl => {
      const s = secs.find(x => x.id === secEl.dataset.sec);
      $$('.rl-it', secEl).forEach(b => bound.set(b, s.items[+b.dataset.n]));
    });
    $$('.rl-it', nav).forEach(b =>
      b.addEventListener('click', () => {
        const src = bound.get(b);
        if (!src) return;
        if (src.root) location.hash = `#${src.key}`;
        else src.el.click();
        $$('.dd-menu').forEach(m => m.classList.add('hidden'));
      })
    );
    $$('.rl-fav', nav).forEach(b =>
      b.addEventListener('click', e => {
        e.stopPropagation();
        const item = allItems.find(it => favoriteId(it) === b.dataset.favoriteToggle);
        if (item) setFavorite(item, b.getAttribute('aria-pressed') !== 'true');
      })
    );
    $$('.rl-root-fav', nav).forEach(b =>
      b.addEventListener('click', e => {
        e.stopPropagation();
        const item = allItems.find(it => favoriteId(it) === b.dataset.favoriteToggle);
        if (item) setFavorite(item, b.getAttribute('aria-pressed') !== 'true');
      })
    );
    $$('.rl-fav-move', nav).forEach(b =>
      b.addEventListener('click', e => {
        e.stopPropagation();
        moveFavorite(
          b.closest('[data-favorite-id]').dataset.favoriteId,
          Number(b.dataset.favoriteMove)
        );
      })
    );
    $$('.rl-favorites-clear', nav).forEach(b =>
      b.addEventListener('click', async () => {
        if (!favoriteOrder().length) return;
        const confirmed = await globalThis.fleetConfirm?.({
          title: 'Clear favorites',
          message: 'Remove every item from Favorites? You can favorite them again at any time.',
          confirmLabel: 'Clear favorites',
          danger: true,
        });
        if (!confirmed) return;
        prefs.favorites = [];
        save();
        sig = '';
        build();
      })
    );
    let draggedFavorite = '';
    $$('.rl-fav-row[draggable="true"]', nav).forEach(row => {
      row.addEventListener('dragstart', e => {
        draggedFavorite = row.dataset.favoriteId;
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedFavorite);
      });
      row.addEventListener('dragend', () => {
        draggedFavorite = '';
        row.classList.remove('is-dragging');
        $$('.rl-fav-row', nav).forEach(r => r.classList.remove('is-drop-target'));
      });
      row.addEventListener('dragover', e => {
        if (!draggedFavorite || draggedFavorite === row.dataset.favoriteId) return;
        e.preventDefault();
        row.classList.add('is-drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        const target = row.dataset.favoriteId;
        const next = favoriteOrder().filter(id => id !== draggedFavorite);
        const index = next.indexOf(target);
        if (draggedFavorite && index >= 0) {
          next.splice(index, 0, draggedFavorite);
          prefs.favorites = next;
          save();
          sig = '';
          build();
          restoreFavoriteFocus(draggedFavorite, `${favoriteLabel(draggedFavorite)} reordered`);
        }
      });
    });
    function toggleSection(sec) {
      const h = $('.rl-toggle', sec);
      const open = sec.classList.toggle('open');
      h.setAttribute('aria-expanded', String(open));
      h.setAttribute(
        'aria-label',
        `${open ? 'Collapse' : 'Expand'} ${$('.rl-h-t', sec).textContent} navigation`
      );
      h.title = h.getAttribute('aria-label');
      prefs['s:' + sec.dataset.sec] = open;
      save();
    }
    $$('.rl-h-main[data-root]', nav).forEach(h =>
      h.addEventListener('click', () => {
        location.hash = h.dataset.root;
        toggleSection(h.closest('.rl-sec'));
      })
    );
    $$('.rl-toggle', nav).forEach(h =>
      h.addEventListener('click', () => {
        toggleSection(h.closest('.rl-sec'));
      })
    );
    nav.scrollTop = scroll;
    sync();
    normalizeMenus();
  }

  /* -------------------------------------------------------------- sync --- */
  function sync() {
    let activeSec = null,
      activeLabel = '';
    const rootView = document.body.dataset.view || '';
    $$('.rl-it', rail).forEach(b => {
      const src = bound.get(b);
      const on = !!src && (src.root ? rootView === src.key : src.el.classList.contains('active'));
      b.classList.toggle('on', on);
      if (on) {
        activeSec = b.dataset.sec;
        activeLabel = $('.rl-t', b).textContent;
      }
    });
    $$('.rl-sec', rail).forEach(s => {
      const rootOn = s.dataset.sec === rootView;
      $('.rl-h-main', s)?.classList.toggle('on', rootOn);
      s.classList.toggle('has-on', rootOn || s.dataset.sec === activeSec);
      if (rootOn) {
        activeSec = s.dataset.sec;
        activeLabel = $('.rl-h-t', s)?.textContent || '';
      }
    });
    // topbar context line — main is owned by app.js, so the title lives here
    const ctx = $('#ctx');
    if (ctx) {
      const isRoot = activeSec && rootView === activeSec;
      const grp =
        activeSec && activeSec !== 'pinned' && !isRoot
          ? $(`.rl-sec[data-sec="${activeSec}"] .rl-h-t`, rail)?.textContent || ''
          : '';
      ctx.innerHTML = grp
        ? `<span class="ctx-g">${esc(grp)}</span><span class="ctx-s">/</span><span class="ctx-v">${esc(activeLabel)}</span>`
        : `<span class="ctx-v">${esc(activeLabel || 'Fleet')}</span>`;
      document.title =
        activeLabel && activeLabel !== 'Fleet'
          ? `${activeLabel} · Domain Fleet Manager`
          : 'Domain Fleet Manager';
    }
    syncNavigationCurrent();
  }

  /* Several views (Guides, Tasks, Containers, Git…) render straight into a
     toolbar with no heading, so the page had no identity of its own. app.js
     owns #app's innerHTML and repaints it on every refresh, so rather than
     editing a dozen render functions we re-assert a heading whenever one is
     missing, using the label the rail already resolved. */
  function ensureTitle() {
    const app = $('#app');
    if (!app || !app.firstElementChild) return; // loading placeholder
    if (app.querySelector(':scope > .page-head, :scope > .crumbs')) return;
    const label = $('#ctx .ctx-v')?.textContent?.trim();
    if (!label || label === 'Fleet') return;
    const h = document.createElement('div');
    h.className = 'page-head fd-title';
    h.innerHTML = `<h1 class="page-title">${esc(label)}</h1>`;
    app.insertBefore(h, app.firstChild);
  }

  // Dynamic views emit many action buttons through innerHTML. A missing type
  // is harmless today until a button is moved inside a form, where the HTML
  // default becomes submit and can discard the operator's current work. Only
  // normalize buttons that are not inside forms; explicit form controls keep
  // their authored behavior.
  function normalizeButtons(root = document) {
    $$('button:not([type])', root).forEach(button => {
      if (!button.closest('form')) button.type = 'button';
    });
    $$('button[title]:not([aria-label])', root).forEach(button => {
      const title = button.getAttribute('title')?.trim();
      if (title) button.setAttribute('aria-label', title);
    });
  }

  function normalizeTables(root = document) {
    $$('table', root).forEach(table => {
      $$('thead th:not([scope])', table).forEach(cell => cell.setAttribute('scope', 'col'));
      $$('tbody tr', table).forEach(row => {
        row.querySelector('th:not([scope])')?.setAttribute('scope', 'row');
      });
    });
  }

  function normalizeActionLinks(root = document) {
    $$('a:not([href])', root).forEach(link => {
      if (link.dataset.fdActionLink === '1') return;
      link.dataset.fdActionLink = '1';
      link.setAttribute('role', 'button');
      if (!link.hasAttribute('tabindex')) link.tabIndex = 0;
      link.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          link.click();
        }
      });
    });
  }

  function normalizeStatusRegions(root = document) {
    $$('.loading:not([role])', root).forEach(region => {
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
    });
    $$('.error-box:not([role])', root).forEach(region => {
      region.setAttribute('role', 'alert');
      region.setAttribute('aria-live', 'assertive');
    });
  }

  function normalizeErrorRecovery(root = document) {
    const app = document.querySelector('#app');
    $$('.error-box', root)
      .filter(region => app?.contains(region))
      .forEach(region => {
        if (region.querySelector('[data-fd-retry]')) return;
        const actions = document.createElement('div');
        actions.className = 'fd-error-actions';
        actions.innerHTML =
          '<button class="btn sm primary" type="button" data-fd-retry>Try again</button>';
        actions.querySelector('[data-fd-retry]').addEventListener('click', () => {
          if (typeof globalThis.fleetRetryView === 'function') globalThis.fleetRetryView();
        });
        region.appendChild(actions);
      });
  }

  function syncMenuButton(button) {
    const menu = button.closest('.tab-dd')?.querySelector('.dd-menu');
    if (!menu) return;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', String(!menu.classList.contains('hidden')));
    menu.setAttribute('role', 'menu');
    $$('.dd-item', menu).forEach(item => item.setAttribute('role', 'menuitem'));
  }

  function normalizeMenus(root = document) {
    $$('.tab-dd-btn', root).forEach(button => {
      if (button.dataset.fdMenuButton !== '1') {
        button.dataset.fdMenuButton = '1';
        button.addEventListener('click', () => requestAnimationFrame(() => syncMenuButton(button)));
      }
      syncMenuButton(button);
    });
  }

  function normalizeFormControls(root = document) {
    $$('input, select, textarea', root).forEach(control => {
      if (
        control.type === 'hidden' ||
        control.hasAttribute('aria-label') ||
        control.hasAttribute('aria-labelledby')
      )
        return;
      if (control.labels?.length || control.closest('label')) return;
      const name =
        control.getAttribute('placeholder') ||
        control.getAttribute('title') ||
        control.getAttribute('name');
      if (name?.trim()) control.setAttribute('aria-label', name.trim());
    });
  }

  function normalizeKeyboardActions(root = document) {
    $$(
      '[role="button"][tabindex="0"]:not(.vt):not(.an-site-row), tr.err-row[tabindex="0"]',
      root
    ).forEach(action => {
      if (action.dataset.fdKeyboardAction === '1') return;
      action.dataset.fdKeyboardAction = '1';
      if (action.tagName === 'TR' && !action.getAttribute('role'))
        action.setAttribute('role', 'button');
      action.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        action.click();
      });
    });
  }

  function syncNavigationCurrent() {
    $$('.tabs [data-view], .tabs .dd-item[data-role]').forEach(item =>
      item.removeAttribute('aria-current')
    );
    $$('.tabs [data-view].active, .tabs .dd-item.active').forEach(item =>
      item.setAttribute('aria-current', 'page')
    );
    $$('.rl-it, .rl-h-main').forEach(item => {
      if (item.classList.contains('on')) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  /* --------------------------------------------------------- saved views --- */
  // A saved view is a client-side navigation snapshot: it stores the current
  // route, fleet filter, and explicitly allowlisted local UI filters without
  // duplicating fleet data or server policy.
  const SAVED_VIEWS_KEY = 'fd.saved-views.v1';
  const SAVED_STATE_KEYS = ['fd.work-board.filters'];
  function captureSavedState() {
    const state = {};
    for (const key of SAVED_STATE_KEYS) {
      try {
        const value = localStorage.getItem(key);
        if (value !== null) state[key] = value;
      } catch {}
    }
    return state;
  }
  function restoreSavedState(state) {
    if (!state || typeof state !== 'object') return;
    for (const key of SAVED_STATE_KEYS) {
      if (typeof state[key] !== 'string') continue;
      try {
        localStorage.setItem(key, state[key]);
      } catch {}
    }
  }
  function readSavedViews() {
    try {
      const value = JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) || '[]');
      return Array.isArray(value) ? value.filter(v => v && v.name && v.hash).slice(0, 12) : [];
    } catch {
      return [];
    }
  }
  function writeSavedViews(views) {
    try {
      localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views.slice(0, 12)));
    } catch {}
  }
  function renderSavedViews(menu) {
    const views = readSavedViews();
    const rows = views
      .map(
        (view, i) =>
          `<div class="view-save-row">
            <button class="view-save-open" role="menuitem" type="button" data-view-save="${i}" title="Open ${esc(view.name)}">
              <span>${esc(view.name)}</span><small>${esc(view.hash)}${view.state?.['fd.work-board.filters'] ? ' · board filters' : ''}</small>
            </button>
            <button class="view-save-delete" role="menuitem" type="button" data-view-delete="${i}" aria-label="Delete ${esc(view.name)}" title="Delete saved view">×</button>
          </div>`
      )
      .join('');
    menu.innerHTML =
      '<button class="view-save-new" role="menuitem" type="button">＋ Save current view</button>' +
      '<div class="view-save-divider"></div>' +
      (rows || '<div class="view-save-empty">No saved views yet.</div>');
  }
  function openSavedViewEditor(menu) {
    menu.querySelector('.view-save-editor')?.remove();
    const editor = document.createElement('form');
    editor.className = 'view-save-editor';
    editor.innerHTML = `<label for="view-save-name">Name this view</label><div><input id="view-save-name" class="cm-input" type="text" maxlength="48" autocomplete="off" placeholder="e.g. Stale production sites" required><button class="btn sm primary" type="submit">Save</button><button class="btn sm view-save-cancel" type="button">Cancel</button></div>`;
    menu.prepend(editor);
    const input = editor.querySelector('#view-save-name');
    editor.addEventListener('submit', e => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      const filter = $('#fleet-filter')?.value?.trim() || '';
      writeSavedViews([
        { name, hash: location.hash || '#control', filter, state: captureSavedState() },
        ...readSavedViews(),
      ]);
      renderSavedViews(menu);
    });
    editor
      .querySelector('.view-save-cancel')
      .addEventListener('click', () => renderSavedViews(menu));
    input.focus();
  }
  function setupSavedViews(actions) {
    if (!actions || $('.view-saves', actions)) return;
    const wrap = document.createElement('div');
    wrap.className = 'view-saves';
    wrap.innerHTML = `
      <button class="btn sm view-saves-toggle" type="button" aria-expanded="false" aria-haspopup="menu">Saved views</button>
      <div class="view-saves-menu hidden" role="menu"></div>`;
    actions.insertBefore(wrap, actions.firstChild);
    const toggle = $('.view-saves-toggle', wrap);
    const menu = $('.view-saves-menu', wrap);
    let restoreFocus = null;
    const close = () => {
      menu.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
      restoreFocus?.focus?.();
      restoreFocus = null;
    };
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      const open = menu.classList.contains('hidden');
      if (open) {
        restoreFocus = document.activeElement;
        renderSavedViews(menu);
        menu.classList.remove('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus());
        return;
      }
      close();
    });
    menu.addEventListener('click', async e => {
      const save = e.target.closest('.view-save-new');
      if (save) {
        openSavedViewEditor(menu);
        return;
      }
      const open = e.target.closest('[data-view-save]');
      if (open) {
        const view = readSavedViews()[Number(open.dataset.viewSave)];
        if (!view) return;
        const approved = await globalThis.fleetBeforeNavigate?.();
        if (approved === false) return;
        restoreSavedState(view.state);
        const filter = $('#fleet-filter');
        if (filter) {
          filter.value = view.filter || '';
          filter.dispatchEvent(new Event('input', { bubbles: true }));
        }
        close();
        location.hash = view.hash;
        return;
      }
      const del = e.target.closest('[data-view-delete]');
      if (del) {
        const views = readSavedViews();
        const index = Number(del.dataset.viewDelete);
        const view = views[index];
        if (!view) return;
        const approved = await globalThis.fleetConfirm?.({
          title: 'Delete saved view?',
          message: `Remove “${view.name}” from Saved views?`,
          confirmLabel: 'Delete view',
          danger: true,
        });
        if (approved === false) return;
        views.splice(index, 1);
        writeSavedViews(views);
        renderSavedViews(menu);
      }
    });
    menu.addEventListener('keydown', e => {
      const items = $$('[role="menuitem"]', menu).filter(item => !item.disabled && !item.hidden);
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const current = items.indexOf(document.activeElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : (current + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
        e.preventDefault();
        close();
      }
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.view-saves')) close();
    });
  }

  function fold(on) {
    document.body.classList.toggle('rail-folded', on);
    prefs.folded = on;
    save();
    $('.rl-fold', rail).title = on ? 'Expand sidebar' : 'Collapse sidebar';
  }

  function setupMobileRail() {
    if ($('.mobile-rail-toggle')) return;
    const bar = $('.topbar');
    if (!bar) return;
    const toggle = document.createElement('button');
    toggle.className = 'mobile-rail-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'rail');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation');
    toggle.title = 'Open navigation';
    toggle.innerHTML = '<span></span><span></span><span></span>';
    const backdrop = document.createElement('button');
    backdrop.className = 'mobile-rail-backdrop';
    backdrop.type = 'button';
    backdrop.tabIndex = -1;
    backdrop.setAttribute('aria-label', 'Close navigation');
    let previousFocus = null;
    const isMobile = () => window.matchMedia?.('(max-width: 720px)').matches ?? false;
    const syncInteractivity = () => {
      const mobileClosed = isMobile() && !document.body.classList.contains('mobile-rail-open');
      rail.inert = mobileClosed;
      rail.setAttribute('aria-hidden', String(mobileClosed));
    };
    const focusableRail = () =>
      [
        toggle,
        ...$$('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])', rail),
      ].filter(
        el => !el.hidden && (el.offsetWidth || el.offsetHeight || el === document.activeElement)
      );
    const close = () => {
      document.body.classList.remove('mobile-rail-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
      toggle.title = 'Open navigation';
      syncInteractivity();
      const target = previousFocus && !rail.contains(previousFocus) ? previousFocus : toggle;
      previousFocus = null;
      requestAnimationFrame(() => target?.focus?.());
    };
    const open = () => {
      previousFocus = document.activeElement;
      document.body.classList.add('mobile-rail-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close navigation');
      toggle.title = 'Close navigation';
      syncInteractivity();
      requestAnimationFrame(() => $('.rl-it, .rl-brand', rail)?.focus?.());
    };
    toggle.addEventListener('click', () =>
      document.body.classList.contains('mobile-rail-open') ? close() : open()
    );
    backdrop.addEventListener('click', close);
    rail.addEventListener('click', e => {
      if (e.target.closest('.rl-it, .rl-h-main, .rl-brand')) close();
    });
    addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.body.classList.contains('mobile-rail-open')) close();
      if (e.key !== 'Tab' || !document.body.classList.contains('mobile-rail-open')) return;
      const focusable = focusableRail();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    addEventListener('resize', syncInteractivity, { passive: true });
    bar.insertBefore(toggle, bar.firstChild);
    document.body.appendChild(backdrop);
    syncInteractivity();
  }

  /* -------------------------------------------------------------- boot --- */
  function boot() {
    const bar = $('.topbar');
    if (!bar || $('#rail')) return;
    document.body.appendChild(rail);
    document.body.classList.add('has-rail');
    if (prefs.folded) fold(true);
    setupMobileRail();

    $('.rl-brand', rail).addEventListener('click', () =>
      $('.tabs .tab[data-view="control"]')?.click()
    );
    $('.rl-fold', rail).addEventListener('click', () =>
      fold(!document.body.classList.contains('rail-folded'))
    );

    if (!$('#ctx')) {
      const ctx = document.createElement('div');
      ctx.id = 'ctx';
      bar.insertBefore(ctx, bar.firstChild);
    }

    setupSavedViews($('.actions'));

    normalizeButtons();
    normalizeTables();
    normalizeActionLinks();
    normalizeStatusRegions();
    normalizeErrorRecovery();
    normalizeMenus();
    normalizeFormControls();
    normalizeKeyboardActions();
    build();
    // app.js fills the agents/group menus asynchronously and re-toggles .active
    // on every render — rebuild when the menus change, re-sync on every route.
    new MutationObserver(() => build()).observe($('.tabs'), { childList: true, subtree: true });
    new MutationObserver(() => {
      sync();
      ensureTitle();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    new MutationObserver(() => {
      normalizeButtons($('#app'));
      normalizeTables($('#app'));
      normalizeActionLinks($('#app'));
      normalizeStatusRegions($('#app'));
      normalizeErrorRecovery($('#app'));
      normalizeMenus();
      normalizeFormControls($('#app'));
      normalizeKeyboardActions($('#app'));
      ensureTitle();
    }).observe($('#app'), { childList: true });
    setInterval(sync, 1500); // catches same-view active swaps (agent → agent)

    addEventListener('keydown', e => {
      if (e.key === '[' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        fold(!document.body.classList.contains('rail-folded'));
      }
    });
  }

  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', boot) : boot();
})();
