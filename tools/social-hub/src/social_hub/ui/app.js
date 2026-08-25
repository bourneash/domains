/* Social Hub UI — a thin client over /api. No build step, no framework:
   this runs on a loopback port next to the other fleet control planes, and a
   toolchain would be more machinery than the whole app. */

const state = { view: 'overview', site: '', sites: [], platforms: [] };

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return node;
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function toast(message, bad = false) {
  const node = el('div', { className: bad ? 'bad' : '' }, message);
  $('#toast').append(node);
  setTimeout(() => node.remove(), bad ? 8000 : 4000);
}

const siteQuery = () => (state.site ? `site=${encodeURIComponent(state.site)}` : '');
const when = iso =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

// ---------------------------------------------------------------- overview
async function renderOverview(root) {
  const { sites } = await api(`/status?${siteQuery()}`).then(d => ({ sites: d.sites }));
  root.append(el('h2', {}, 'Sites'));
  const cards = el('div', { className: 'cards' });
  const names = Object.keys(sites);
  if (!names.length) {
    root.append(
      el('div', { className: 'empty' }, 'No managed sites yet — add ops/social/hub.yaml to a site.')
    );
    return;
  }
  for (const name of names) {
    const info = sites[name];
    const counts = info.counts || {};
    const card = el('div', { className: 'card' }, el('h3', {}, name));
    const row = (label, value) =>
      card.append(el('div', { className: 'kv' }, label, el('b', {}, String(value))));
    row('drafts waiting', counts.draft || 0);
    row('scheduled', counts.scheduled || 0);
    row('posted', counts.posted || 0);
    row('failed', counts.failed || 0);
    row('inbox (new)', info.inbox_new || 0);
    row('next send', when(info.next_send));
    const chans = el(
      'div',
      { className: 'counter' },
      info.channels
        .filter(c => c.enabled)
        .map(c => `${c.platform}${c.persona ? '/' + c.persona : ''}`)
        .join(', ') || 'no live channels'
    );
    card.append(el('div', { className: 'kv' }), chans);
    cards.append(card);
  }
  root.append(cards);

  const { runs } = await api('/runs?limit=8');
  root.append(el('h2', {}, 'Recent runs'));
  const table = el(
    'table',
    {},
    el('tr', {}, ...['When', 'Site', 'Kind', 'OK', 'Summary'].map(h => el('th', {}, h)))
  );
  for (const run of runs) {
    const stats = run.stats || {};
    const summary = [
      `+${(stats.ingest || {}).new || 0} src`,
      `+${(stats.generate || {}).drafted || 0} drafts`,
      `+${(stats.replies || {}).drafted || 0} replies`,
      `${stats.published || 0} sent`,
    ].join('  ');
    table.append(
      el(
        'tr',
        {},
        el('td', {}, when(run.started_at)),
        el('td', {}, run.site || '—'),
        el('td', {}, run.kind),
        el('td', {}, run.ok ? '✅' : '⚠️'),
        el('td', {}, summary)
      )
    );
  }
  root.append(table);
}

// ------------------------------------------------------------------- queue
function postCard(post, { onChange }) {
  const card = el('div', { className: `post ${post.status}` });
  card.append(
    el(
      'div',
      { className: 'meta' },
      el('span', { className: `tag ${post.status}` }, post.status),
      post.kind === 'reply' ? el('span', { className: 'tag reply' }, 'reply') : null,
      el('span', {}, post.site),
      el('span', {}, post.platform),
      el(
        'span',
        {},
        post.scheduled_at ? `→ ${when(post.scheduled_at)}` : `created ${when(post.created_at)}`
      ),
      el(
        'span',
        { className: 'counter' },
        `#${post.id} · ${post.body.length} chars · ${post.ai_model || post.origin}`
      )
    )
  );

  const body = el('div', { className: 'body' }, post.body);
  card.append(body);
  if (post.link)
    card.append(el('a', { className: 'link', href: post.link, target: '_blank' }, post.link));
  if (post.remote_url)
    card.append(
      el(
        'div',
        {},
        el('a', { className: 'link', href: post.remote_url, target: '_blank' }, post.remote_url)
      )
    );
  if (post.error) card.append(el('div', { className: 'err' }, post.error));

  const actions = el('div', { className: 'actions' });
  const act = (label, fn, cls = '') =>
    actions.append(el('button', { className: cls, onclick: fn }, label));
  const editable = !['posted', 'rejected', 'cancelled', 'publishing'].includes(post.status);

  if (editable) {
    let editing = false;
    act('Edit', async event => {
      editing = !editing;
      body.contentEditable = editing;
      event.target.textContent = editing ? 'Save' : 'Edit';
      if (editing) {
        body.focus();
        return;
      }
      await api(`/posts/${post.id}`, { method: 'PATCH', body: { body: body.textContent.trim() } });
      toast(`post ${post.id} updated`);
      onChange();
    });
  }
  if (post.status === 'draft') {
    act(
      'Approve',
      async () => {
        await api(`/posts/${post.id}/approve`, { method: 'POST', body: {} });
        toast(`post ${post.id} scheduled`);
        onChange();
      },
      'primary'
    );
    act('Reject', async () => {
      await api(`/posts/${post.id}/reject`, { method: 'POST', body: {} });
      toast(`post ${post.id} rejected`);
      onChange();
    });
  }
  if (['draft', 'approved', 'scheduled', 'failed'].includes(post.status)) {
    act('Post now', async () => {
      const res = await api(`/posts/${post.id}/publish`, { method: 'POST' });
      res.ok ? toast(`sent: ${res.url || ''}`) : toast(`failed: ${res.error}`, true);
      onChange();
    });
    act('Reschedule', async () => {
      const input = prompt(
        'Send at (ISO, UTC):',
        post.scheduled_at || new Date().toISOString().slice(0, 16)
      );
      if (!input) return;
      await api(`/posts/${post.id}`, { method: 'PATCH', body: { scheduled_at: input } });
      onChange();
    });
  }
  if (post.status === 'scheduled')
    act('Cancel', async () => {
      await api(`/posts/${post.id}/cancel`, { method: 'POST' });
      onChange();
    });

  card.append(actions);
  return card;
}

async function renderQueue(root) {
  const groups = [
    ['Needs review', 'draft'],
    ['Scheduled', 'approved,scheduled,publishing'],
    ['Recently posted', 'posted'],
    ['Failed', 'failed'],
  ];
  for (const [title, status] of groups) {
    const { posts } = await api(`/posts?status=${status}&limit=60&${siteQuery()}`);
    if (!posts.length && status === 'posted') continue;
    root.append(el('h2', {}, `${title} (${posts.length})`));
    if (!posts.length) {
      root.append(el('div', { className: 'empty' }, 'Nothing here.'));
      continue;
    }
    const list = status === 'posted' ? posts.slice(-15).reverse() : posts;
    for (const post of list) root.append(postCard(post, { onChange: render }));
  }
}

// ---------------------------------------------------------------- calendar
async function renderCalendar(root) {
  const { posts } = await api(`/calendar?days=14&${siteQuery()}`);
  if (!posts.length) {
    root.append(el('div', { className: 'empty' }, 'Nothing scheduled in the next 14 days.'));
    return;
  }
  const byDay = new Map();
  for (const post of posts) {
    const day = new Date(post.scheduled_at).toDateString();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(post);
  }
  for (const [day, items] of byDay) {
    const group = el(
      'div',
      { className: 'daygroup' },
      el('div', { className: 'dayhead' }, `${day} — ${items.length}`)
    );
    for (const post of items) group.append(postCard(post, { onChange: render }));
    root.append(group);
  }
}

// ------------------------------------------------------------------- inbox
async function renderInbox(root) {
  const { mentions } = await api(`/inbox?status=new,drafted&limit=80&${siteQuery()}`);
  if (!mentions.length) {
    root.append(el('div', { className: 'empty' }, 'Inbox is empty.'));
    return;
  }
  for (const mention of mentions) {
    const card = el(
      'div',
      { className: 'post' },
      el(
        'div',
        { className: 'meta' },
        el('span', { className: 'tag' }, mention.status),
        el('span', {}, `${mention.site} · ${mention.platform}`),
        el('span', {}, `@${mention.author_handle || 'unknown'}`),
        el('span', {}, when(mention.remote_created_at || mention.fetched_at))
      ),
      el('div', { className: 'body' }, mention.text)
    );
    if (mention.url)
      card.append(
        el('a', { className: 'link', href: mention.url, target: '_blank' }, 'view on platform')
      );

    const actions = el('div', { className: 'actions' });
    actions.append(
      el(
        'button',
        {
          className: 'primary',
          onclick: async () => {
            const res = await api(`/inbox/${mention.id}/draft`, { method: 'POST' });
            res.ok ? toast('reply drafted') : toast('model declined to reply', true);
            render();
          },
        },
        mention.reply ? 'Redraft reply' : 'Draft reply'
      )
    );
    actions.append(
      el(
        'button',
        {
          onclick: async () => {
            await api(`/inbox/${mention.id}/status`, {
              method: 'POST',
              body: { status: 'ignored' },
            });
            render();
          },
        },
        'Ignore'
      )
    );
    card.append(actions);
    root.append(card);

    if (mention.reply) root.append(postCard(mention.reply, { onChange: render }));
  }
}

// ---------------------------------------------------------------- channels
async function renderChannels(root) {
  const { channels } = await api(`/channels?${siteQuery()}`);
  const table = el(
    'table',
    {},
    el(
      'tr',
      {},
      ...['Site', 'Platform', 'As', 'Handle', 'Registry', 'Creds', 'Last post', ''].map(h =>
        el('th', {}, h)
      )
    )
  );
  for (const chan of channels) {
    const toggle = el(
      'button',
      {
        onclick: async () => {
          await api(`/channels/${chan.id}`, { method: 'PATCH', body: { enabled: !chan.enabled } });
          render();
        },
      },
      chan.enabled ? 'Disable' : 'Enable'
    );
    const verify = el(
      'button',
      {
        onclick: async () => {
          const res = await api(`/channels/${chan.id}/verify`, { method: 'POST' });
          res.ok
            ? toast(`${chan.platform}: ok ${res.handle || ''}`)
            : toast(`${chan.platform}: ${res.error}`, true);
          render();
        },
      },
      'Verify'
    );
    table.append(
      el(
        'tr',
        {},
        el('td', {}, chan.site),
        el('td', {}, chan.platform),
        el('td', {}, chan.persona || 'brand'),
        el('td', {}, chan.handle || '—'),
        el('td', {}, chan.status),
        el('td', {}, chan.has_creds ? 'yes' : chan.status === 'local' ? 'n/a' : 'no'),
        el('td', {}, when(chan.last_posted_at)),
        el('td', {}, el('div', { className: 'actions' }, toggle, verify))
      )
    );
  }
  root.append(el('h2', {}, 'Channels'), table);
  root.append(
    el(
      'div',
      { className: 'actions' },
      el(
        'button',
        {
          onclick: async () => {
            toast(JSON.stringify(await api('/channels/sync', { method: 'POST', body: {} })));
            render();
          },
        },
        'Sync from registry'
      )
    )
  );
}

// ---------------------------------------------------------------- activity
async function renderActivity(root) {
  const { events } = await api(`/events?limit=120&${siteQuery()}`);
  const table = el(
    'table',
    {},
    el('tr', {}, ...['When', 'Site', 'Event', 'Detail'].map(h => el('th', {}, h)))
  );
  for (const event of events) {
    table.append(
      el(
        'tr',
        {},
        el('td', {}, when(event.ts)),
        el('td', {}, event.site || '—'),
        el('td', {}, event.kind),
        el('td', {}, event.message || '')
      )
    );
  }
  root.append(el('h2', {}, 'Activity'), table);
}

// -------------------------------------------------------------------- shell
const VIEWS = {
  overview: renderOverview,
  queue: renderQueue,
  calendar: renderCalendar,
  inbox: renderInbox,
  channels: renderChannels,
  activity: renderActivity,
};

async function render() {
  const root = $('#view');
  root.innerHTML = '';
  try {
    await VIEWS[state.view](root);
  } catch (err) {
    root.append(el('div', { className: 'empty' }, `Failed to load: ${err.message}`));
  }
}

async function boot() {
  const { sites } = await api('/sites');
  state.sites = sites.map(s => s.site);
  state.platforms = [...new Set(sites.flatMap(s => s.platforms))];

  const filter = $('#siteFilter');
  for (const site of state.sites) filter.append(el('option', { value: site }, site));
  filter.onchange = () => {
    state.site = filter.value;
    render();
  };

  for (const button of document.querySelectorAll('#tabs button')) {
    button.onclick = () => {
      document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      state.view = button.dataset.view;
      location.hash = state.view;
      render();
    };
  }
  if (location.hash) {
    const target = document.querySelector(
      `#tabs button[data-view="${location.hash.slice(1).split('?')[0]}"]`
    );
    if (target) target.click();
  }

  $('#tickBtn').onclick = async event => {
    event.target.disabled = true;
    event.target.textContent = 'Running…';
    try {
      const result = await api('/tick', { method: 'POST', body: { site: state.site || null } });
      const sent = Object.values(result.sites).reduce((n, s) => n + (s.published || 0), 0);
      toast(`tick done — ${sent} published`);
    } catch (err) {
      toast(`tick failed: ${err.message}`, true);
    }
    event.target.disabled = false;
    event.target.textContent = 'Run tick';
    render();
  };

  const dialog = $('#composeDlg');
  for (const site of state.sites) $('#composeSite').append(el('option', { value: site }, site));
  for (const platform of state.platforms)
    $('#composePlatform').append(el('option', { value: platform }, platform));
  $('#composeBtn').onclick = () => dialog.showModal();
  $('#composeForm').onsubmit = async event => {
    if (event.submitter.value !== 'create') return;
    const data = new FormData(event.target);
    try {
      const post = await api('/posts', {
        method: 'POST',
        body: {
          site: data.get('site'),
          platform: data.get('platform'),
          body: (data.get('body') || '').trim(),
          schedule: data.get('schedule') === 'on',
        },
      });
      toast(`post ${post.id} created`);
      render();
    } catch (err) {
      toast(`compose failed: ${err.message}`, true);
    }
  };

  render();
  setInterval(render, 60000);
}

boot();
