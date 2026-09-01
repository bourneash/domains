/* ============================================================================
   Fleet Dashboard — shell.js
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
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ---------------------------------------------------------- 1. VITALS -- */
  const railHTML = `
    <div class="vt" data-vt="sites"      style="--vt-c:var(--a1)"><div class="vt-k">Fleet</div><div class="vt-v">—</div><div class="vt-sub">sites discovered</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="fresh"      style="--vt-c:var(--green)"><div class="vt-k">Roles fresh</div><div class="vt-v">—</div><div class="vt-sub">ran within window</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="attention"  style="--vt-c:var(--yellow)"><div class="vt-k">Needs attention</div><div class="vt-v">—</div><div class="vt-sub">stale or overdue</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="paused"     style="--vt-c:var(--purple)"><div class="vt-k">Paused</div><div class="vt-v">—</div><div class="vt-sub">disabled by flag</div><div class="vt-meter"><i></i></div></div>
    <div class="vt" data-vt="containers" style="--vt-c:var(--a3)"><div class="vt-k">Containers</div><div class="vt-v">—</div><div class="vt-sub">running</div><div class="vt-bars"></div></div>
    <div class="vt" data-vt="health"     style="--vt-c:var(--green)"><div class="vt-k">Fleet health</div><div class="vt-v">—</div><div class="vt-sub">weighted uptime</div><div class="vt-meter"><i></i></div></div>`;

  const rail = document.createElement('section');
  rail.id = 'vitals';
  rail.className = 'hidden';
  rail.setAttribute('aria-label', 'Fleet vitals');
  rail.innerHTML = railHTML;

  const cell = (k) => $(`.vt[data-vt="${k}"]`, rail);
  const setVal = (k, v, sub) => {
    const c = cell(k); if (!c) return;
    const el = $('.vt-v', c);
    if (el.innerHTML !== v) { el.innerHTML = v; if (!reduce) { el.animate([{opacity:.35,transform:'translateY(4px)'},{opacity:1,transform:'none'}], {duration:280, easing:'cubic-bezier(.16,1,.3,1)'}); } }
    if (sub != null) $('.vt-sub', c).textContent = sub;
  };
  const setMeter = (k, pct) => { const i = $('.vt-meter i', cell(k) || document.createElement('div')); if (i) i.style.width = Math.max(2, Math.min(100, pct)) + '%'; };

  let vitalsTimer = null;
  async function loadVitals() {
    try {
      const [rRes, cRes] = await Promise.all([
        fetch('/api/roles', { credentials: 'same-origin' }),
        fetch('/api/containers', { credentials: 'same-origin' }),
      ]);
      if (!rRes.ok || !cRes.ok) { rail.classList.add('hidden'); return; }
      const roles = await rRes.json();
      const cts = await cRes.json();

      let fresh = 0, stale = 0, overdue = 0, paused = 0, total = 0;
      for (const s of (roles.sites || [])) {
        for (const c of Object.values(s.cells || {})) {
          if (!c || !c.scheduled) continue;
          total++;
          if (c.enabled === false) { paused++; continue; }
          if (c.state === 'fresh') fresh++;
          else if (c.state === 'stale') stale++;
          else if (c.state === 'overdue') overdue++;
        }
      }
      const live = total - paused || 1;
      const running = cts.filter(c => c.running).length;
      const unhealthy = cts.filter(c => c.unhealthy).length;
      const healthPct = Math.round((fresh / live) * 100);

      setVal('sites', String((roles.sites || []).length), `${(roles.roles || []).length} distinct roles`);
      setMeter('sites', 100);

      setVal('fresh', `${fresh}<small>/${live}</small>`, 'ran within window');
      setMeter('fresh', (fresh / live) * 100);

      const att = stale + overdue;
      const attCell = cell('attention');
      if (attCell) attCell.style.setProperty('--vt-c', overdue ? 'var(--red)' : att ? 'var(--yellow)' : 'var(--green)');
      setVal('attention', String(att), overdue ? `${overdue} overdue · ${stale} stale` : `${stale} stale`);
      setMeter('attention', (att / live) * 100);

      setVal('paused', String(paused), 'disabled by flag');
      setMeter('paused', (paused / (total || 1)) * 100);

      setVal('containers', `${running}<small>/${cts.length}</small>`, unhealthy ? `${unhealthy} unhealthy` : 'all healthy');
      const bars = $('.vt-bars', cell('containers'));
      if (bars) {
        const slice = cts.slice(0, 26);
        bars.innerHTML = slice.map(() => '<i></i>').join('');
        $$('i', bars).forEach((b, i) => {
          const c = slice[i];
          b.style.height = (c.running ? (c.unhealthy ? 45 : 100) : 22) + '%';
          b.style.background = c.unhealthy ? 'var(--red)' : c.running ? 'var(--a3)' : 'var(--faint)';
          b.title = `${c.name} — ${c.status}`;
        });
      }

      const hCell = cell('health');
      if (hCell) hCell.style.setProperty('--vt-c', healthPct >= 90 ? 'var(--green)' : healthPct >= 70 ? 'var(--yellow)' : 'var(--red)');
      setVal('health', `${healthPct}<small>%</small>`, unhealthy ? 'container degradation' : 'weighted uptime');
      setMeter('health', healthPct);

      rail.classList.remove('hidden');

      // compact mirror in the nav rail's foot, so health is on screen even
      // when you've scrolled the vitals off the top
      const foot = document.querySelector('#rail .rl-foot');
      if (foot) {
        const tone = healthPct >= 90 ? 'ok' : healthPct >= 70 ? 'warn' : 'bad';
        foot.innerHTML = `
          <div class="rl-pulse ${tone}" title="${esc(`${fresh}/${live} roles fresh · ${running}/${cts.length} containers running`)}">
            <span class="rl-pulse-dot"></span>
            <span class="rl-pulse-t">Fleet health</span>
            <span class="rl-pulse-v">${healthPct}%</span>
          </div>`;
      }
    } catch { rail.classList.add('hidden'); }
  }

  /* -------------------------------------------------- 2. COMMAND PALETTE -- */
  const palette = document.createElement('div');
  palette.id = 'cmdk';
  palette.className = 'hidden';
  palette.innerHTML = `
    <div class="cmdk-card" role="dialog" aria-modal="true" aria-label="Command palette">
      <input type="text" placeholder="Jump to a view, an agent, a site…" spellcheck="false" autocomplete="off" />
      <div class="cmdk-list"></div>
      <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
    </div>`;

  const pInput = $('input', palette), pList = $('.cmdk-list', palette);
  let items = [], sel = 0;

  /* Commands are harvested from the live nav, so the palette never drifts out
     of sync with whatever tabs/agents the server advertises. */
  function harvest() {
    const out = [];
    $$('.tabs .tab[data-view]').forEach(b => out.push({ label: b.textContent.trim(), group: 'view', ico: '◈', run: () => b.click() }));
    $$('.tabs .dd-menu .dd-item').forEach(d => {
      const grpBtn = d.closest('.tab-dd')?.querySelector('.tab-dd-btn');
      const group = (grpBtn?.textContent || '').replace('▾', '').trim().toLowerCase() || 'go';
      // strip the trailing count chip so "Engineer26" doesn't become the label
      const c = d.cloneNode(true);
      c.querySelectorAll('.dd-count').forEach(n => n.remove());
      const label = c.textContent.trim();
      out.push({
        label, group, ico: group === 'agents' ? '◉' : '◇',
        run: () => { d.click(); $$('.dd-menu').forEach(m => m.classList.add('hidden')); },
      });
    });
    out.push({ label: 'Refresh now', group: 'action', ico: '↻', run: () => $('#refresh')?.click() });
    out.push({ label: 'Toggle auto-refresh', group: 'action', ico: '⟳', run: () => $('#auto-on')?.click() });
    out.push({ label: 'Filter sites…', group: 'action', ico: '⌕', run: () => setTimeout(() => $('#fleet-filter')?.focus(), 60) });
    const seen = new Set();
    return out.filter(i => i.label && !seen.has(i.group + i.label) && seen.add(i.group + i.label));
  }

  const score = (label, q) => {
    const l = label.toLowerCase();
    if (!q) return 1;
    if (l.startsWith(q)) return 100;
    if (l.includes(q)) return 60;
    let i = 0; for (const ch of l) if (ch === q[i]) i++;      // subsequence
    return i === q.length ? 20 : 0;
  };

  function draw() {
    const q = pInput.value.trim().toLowerCase();
    items = harvest().map(i => ({ ...i, s: score(i.label, q) })).filter(i => i.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 40);
    sel = 0;
    pList.innerHTML = items.length
      ? items.map((i, n) => `<div class="cmdk-row${n === 0 ? ' sel' : ''}" data-n="${n}"><span class="cmdk-ico">${esc(i.ico)}</span><span></span><span class="cmdk-grp">${esc(i.group)}</span></div>`).join('')
      : '<div class="cmdk-empty">Nothing matches that.</div>';
    $$('.cmdk-row', pList).forEach((r, n) => {
      r.children[1].textContent = items[n].label;
      r.onmouseenter = () => mark(n);
      r.onclick = () => fire(n);
    });
  }
  function mark(n) {
    sel = (n + items.length) % items.length;
    $$('.cmdk-row', pList).forEach((r, i) => r.classList.toggle('sel', i === sel));
    $$('.cmdk-row', pList)[sel]?.scrollIntoView({ block: 'nearest' });
  }
  function fire(n) { const it = items[n]; close(); if (it) setTimeout(it.run, 10); }
  function open() { palette.classList.remove('hidden'); pInput.value = ''; draw(); pInput.focus(); }
  function close() { palette.classList.add('hidden'); }

  pInput.addEventListener('input', draw);
  palette.addEventListener('mousedown', e => { if (e.target === palette) close(); });
  pInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); mark(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark(sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); fire(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.classList.contains('hidden') ? open() : close();
    }
  });

  /* -------------------------------------------------------- 3. MOTION ---- */
  // view entrance: fires only when the route actually changes, so in-place
  // auto-refreshes (app.js softRender) never flash.
  function watchView() {
    const main = $('#app'); if (!main) return;
    let last = document.body.dataset.view;
    new MutationObserver(() => {
      const v = document.body.dataset.view;
      if (v === last) return;
      last = v;
      if (reduce) return;
      main.classList.remove('view-enter');
      void main.offsetWidth;
      main.classList.add('view-enter');
      setTimeout(() => main.classList.remove('view-enter'), 700);
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  }

  // ripple on every button, present or future (delegated).
  addEventListener('pointerdown', e => {
    if (reduce) return;
    const b = e.target.closest('.btn'); if (!b || b.disabled) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 520);
  }, { passive: true });

  /* ----------------------------------------------------------- 4. BOOT --- */
  function boot() {
    const main = $('#app');
    if (main && !$('#vitals')) main.parentNode.insertBefore(rail, main);
    if (!$('#cmdk')) document.body.appendChild(palette);

    // ⌘K affordance in the topbar
    const actions = $('.actions');
    if (actions && !$('.cmdk-hint')) {
      const hint = document.createElement('button');
      hint.className = 'cmdk-hint';
      hint.type = 'button';
      hint.title = 'Command palette';
      hint.innerHTML = `<span>⌘</span><kbd>K</kbd>`;
      hint.onclick = open;
      actions.insertBefore(hint, actions.firstChild);
    }

    watchView();
    loadVitals();
    clearInterval(vitalsTimer);
    vitalsTimer = setInterval(() => { if (!document.hidden) loadVitals(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadVitals(); });
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
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* 24px stroke icons, keyed by view. Anything unmapped falls back to a dot,
     so a new view never renders broken. */
  const P = {
    control:      'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    cron:         'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2',
    containers:   'M12 2.8 20.5 7v10L12 21.2 3.5 17V7zM3.5 7 12 11.4 20.5 7M12 11.4V21',
    git:          'M6 4v9a3 3 0 0 0 3 3h6M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 8v2a3 3 0 0 1-3 3h-3',
    githygiene:   'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.2l2.4 2.4 4.6-5',
    tasks:        'M4 6.5 5.6 8 8.5 5M4 12.5 5.6 14l2.9-3M4 18.5 5.6 20l2.9-3M11.5 6.5H20M11.5 12.5H20M11.5 18.5H20',
    deploys:      'M12 15V3.5M12 3.5 8 7.5M12 3.5l4 4M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15',
    domains:      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.2 9h17.6M3.2 15h17.6M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z',
    guardrails:   'M12 2.8 20 6v6.2c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6zM9 12l2.2 2.2L15.5 10',
    guides:       'M4 4.5h6a2.5 2.5 0 0 1 2 2.5v13a2 2 0 0 0-2-1.6H4zM20 4.5h-6a2.5 2.5 0 0 0-2 2.5v13a2 2 0 0 1 2-1.6h6z',
    productfeed:  'M11.5 3.2 20 11.7a1.8 1.8 0 0 1 0 2.5l-5.8 5.8a1.8 1.8 0 0 1-2.5 0L3.2 11.5V3.2zM7.6 7.6h.01',
    datahub:      'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    datahubimages:'M3.5 5.5h17v13h-17zM3.5 15l4.5-4.2 3.4 3.2 3.6-3.9 5.5 5.4M8.4 9.4h.01',
    sitefacts:    'M13.5 3.2H6.5A1.5 1.5 0 0 0 5 4.7v14.6a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8.7zM13.5 3.2V8.7H19M8.5 13h7M8.5 16.5h4.5',
    analytics:    'M4 20V13M9.3 20V7M14.7 20v-8.5M20 20V4',
    social:       'M17 8.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM6.5 15.1a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM17 21.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM8.8 11.3l5.9-2.7M8.8 13.9l5.9 2.7',
    socialhub:    'M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l5.5 4V5L8 9H5.5A1.5 1.5 0 0 0 4 10.5zM17.2 8.6a5 5 0 0 1 0 6.8M19.8 6a8.5 8.5 0 0 1 0 12',
    automation:   'M13.3 2.5 4 13.8h6.4l-.7 7.7L19 10.2h-6.4z',
    aiusage:      'M3.5 12a8.5 8.5 0 0 1 17 0M12 12l4-3.4M12 19.5v.01',
    aioptimizer:  'M5 20v-6M5 10V4M12 20v-9M12 7V4M19 20v-3M19 13V4M2.6 14h4.8M9.6 7h4.8M16.6 17h4.8',
    aiinventory:  'M12 2.8 21 7.4l-9 4.6-9-4.6zM3 12.2l9 4.6 9-4.6M3 16.8l9 4.6 9-4.6',
    taskbudget:   'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v10M14.6 9.4a2.6 2.6 0 0 0-2.6-1.4h-.4a2.1 2.1 0 0 0-.4 4.1l2 .4a2.1 2.1 0 0 1-.4 4.1H12a2.6 2.6 0 0 1-2.6-1.4',
    compliance:   'M12 2.8 20 6v6.2c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6zM9.2 11.9l2.1 2.1 3.9-4.2',
    lint:         'M8.5 6.5a3.5 3.5 0 1 1 7 0M5.5 11.5h13M6.5 9.5v4.5a5.5 5.5 0 0 0 11 0V9.5zM3.5 9l2.5 1M20.5 9 18 10M3.5 17.5 6 16.4M20.5 17.5 18 16.4M12 14.5v6',
    health:       'M3 12.5h4l2-4.5 3 9 2.5-6 1.6 3h4.9',
    errors:       'M10.6 4.1 2.9 17.2a1.6 1.6 0 0 0 1.4 2.4h15.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4.1a1.6 1.6 0 0 0-2.8 0zM12 9.5v4M12 17h.01',
    activity:     'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM7.6 12.4h2.2l1.4-3.4 1.9 6 1.3-2.6h2',
    devsandbox:   'M3.5 5.5h17v13h-17zM7.2 10l2.4 2.2-2.4 2.2M12.4 15h4.2',
    agent:        'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z',
  };
  const GRP = { agents: 'agent', ops: 'cron', content: 'guides', growth: 'analytics', quality: 'compliance' };
  const icon = (k) => P[k]
    ? `<svg class="rl-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${P[k]}"/></svg>`
    : `<svg class="rl-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3.4"/></svg>`;

  const prefs = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch {} };

  const rail = document.createElement('aside');
  rail.id = 'rail';
  rail.innerHTML = `
    <div class="rl-top">
      <a class="rl-brand" title="Domain Control">
        <span class="rl-mark"></span>
        <span class="rl-word">Fleet<b>Deck</b></span>
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
      key: el.dataset.view, label: el.textContent.trim(), el,
    }));
    if (pinned.length) out.push({ id: 'pinned', label: '', items: pinned, always: true });

    $$('.tabs .tab-dd').forEach(dd => {
      const btn = $('.tab-dd-btn', dd);
      const id = dd.dataset.group || (dd.id === 'agents-dd' ? 'agents' : '');
      if (!btn || !id) return;
      const items = $$('.dd-menu .dd-item', dd).map(el => {
        const c = el.cloneNode(true);
        c.querySelectorAll('.dd-count').forEach(n => n.remove());
        return {
          key: el.dataset.view || 'agent',
          label: c.textContent.trim(),
          count: $('.dd-count', el)?.textContent.trim() || '',
          el,
        };
      });
      if (items.length) out.push({ id, label: btn.textContent.replace('▾', '').trim(), items });
    });
    return out;
  }

  let bound = new WeakMap();
  function build() {
    const nav = $('.rl-nav', rail);
    const secs = sections();
    if (!secs.length) return;
    nav.innerHTML = secs.map(s => {
      // Agents is 30+ entries — collapsed by default so the rail stays scannable;
      // sync() re-opens whichever section holds the active view.
      const dflt = s.id !== 'agents';
      const open = s.always || (prefs['s:' + s.id] ?? dflt);
      const head = s.always ? '' : `
        <button class="rl-h" type="button" data-sec="${s.id}" aria-expanded="${open}">
          ${icon(GRP[s.id] || s.id)}
          <span class="rl-h-t">${esc(s.label)}</span>
          <span class="rl-h-n">${s.items.length}</span>
          <svg class="rl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 10.5 12 14l3.5-3.5"/></svg>
        </button>`;
      const items = s.items.map((it, n) => `
        <button class="rl-it" type="button" data-sec="${esc(s.id)}" data-n="${n}" title="${esc(it.label)}">
          ${icon(s.id === 'agents' ? 'agent' : it.key)}
          <span class="rl-t">${esc(it.label)}</span>
          ${it.count ? `<span class="rl-n">${esc(it.count)}</span>` : ''}
        </button>`).join('');
      return `<div class="rl-sec${open ? ' open' : ''}" data-sec="${esc(s.id)}">${head}<div class="rl-items">${items}</div></div>`;
    }).join('');

    bound = new WeakMap();
    $$('.rl-sec', nav).forEach(secEl => {
      const s = secs.find(x => x.id === secEl.dataset.sec);
      $$('.rl-it', secEl).forEach(b => bound.set(b, s.items[+b.dataset.n].el));
    });
    $$('.rl-it', nav).forEach(b => b.addEventListener('click', () => {
      const src = bound.get(b);
      if (!src) return;
      src.click();
      $$('.dd-menu').forEach(m => m.classList.add('hidden'));
    }));
    $$('.rl-h', nav).forEach(h => h.addEventListener('click', () => {
      const sec = h.closest('.rl-sec');
      const open = sec.classList.toggle('open');
      h.setAttribute('aria-expanded', String(open));
      prefs['s:' + sec.dataset.sec] = open;
      save();
    }));
    sync();
  }

  /* -------------------------------------------------------------- sync --- */
  function sync() {
    let activeSec = null, activeLabel = '';
    $$('.rl-it', rail).forEach(b => {
      const src = bound.get(b);
      const on = !!src && src.classList.contains('active');
      b.classList.toggle('on', on);
      if (on) { activeSec = b.dataset.sec; activeLabel = $('.rl-t', b).textContent; }
    });
    // an active item inside a collapsed section: open it so you can see where you are
    if (activeSec) {
      const sec = $(`.rl-sec[data-sec="${activeSec}"]`, rail);
      if (sec && !sec.classList.contains('open')) {
        sec.classList.add('open');
        $('.rl-h', sec)?.setAttribute('aria-expanded', 'true');
      }
      $$('.rl-sec', rail).forEach(s => s.classList.toggle('has-on', s.dataset.sec === activeSec));
    }
    // topbar context line — main is owned by app.js, so the title lives here
    const ctx = $('#ctx');
    if (ctx) {
      const grp = activeSec && activeSec !== 'pinned'
        ? ($(`.rl-sec[data-sec="${activeSec}"] .rl-h-t`, rail)?.textContent || '') : '';
      ctx.innerHTML = grp
        ? `<span class="ctx-g">${esc(grp)}</span><span class="ctx-s">/</span><span class="ctx-v">${esc(activeLabel)}</span>`
        : `<span class="ctx-v">${esc(activeLabel || 'Fleet')}</span>`;
    }
  }

  function fold(on) {
    document.body.classList.toggle('rail-folded', on);
    prefs.folded = on; save();
    $('.rl-fold', rail).title = on ? 'Expand sidebar' : 'Collapse sidebar';
  }

  /* -------------------------------------------------------------- boot --- */
  function boot() {
    const bar = $('.topbar'); if (!bar || $('#rail')) return;
    document.body.appendChild(rail);
    document.body.classList.add('has-rail');
    if (prefs.folded) fold(true);

    $('.rl-brand', rail).addEventListener('click', () => $('.tabs .tab[data-view="control"]')?.click());
    $('.rl-fold', rail).addEventListener('click', () => fold(!document.body.classList.contains('rail-folded')));

    if (!$('#ctx')) {
      const ctx = document.createElement('div');
      ctx.id = 'ctx';
      bar.insertBefore(ctx, bar.firstChild);
    }

    build();
    // app.js fills the agents/group menus asynchronously and re-toggles .active
    // on every render — rebuild when the menus change, re-sync on every route.
    new MutationObserver(() => build()).observe($('.tabs'), { childList: true, subtree: true });
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    setInterval(sync, 1500);   // catches same-view active swaps (agent → agent)

    addEventListener('keydown', e => {
      if (e.key === '[' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        fold(!document.body.classList.contains('rail-folded'));
      }
    });
  }

  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', boot) : boot();
})();
