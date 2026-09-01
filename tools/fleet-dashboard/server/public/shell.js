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
      ? items.map((i, n) => `<div class="cmdk-row${n === 0 ? ' sel' : ''}" data-n="${n}"><span class="cmdk-ico">${i.ico}</span><span></span><span class="cmdk-grp">${i.group}</span></div>`).join('')
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
