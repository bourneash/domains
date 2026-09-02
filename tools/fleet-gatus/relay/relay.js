'use strict';

// fleet-gatus alert relay.
//
// WHY THIS EXISTS
// ---------------
// Gatus alerts per ENDPOINT. A site-wide failure therefore produces one Slack
// message per check — girlpain.com's DNS blip on 2026-09-02 produced 18 of them
// (9 TRIGGERED + 9 RESOLVED), each carrying nothing but a raw Go error string
// and an empty description. That is a lot of noise saying very little: nowhere
// in those 18 messages did it say "all nine failed identically, so this is the
// site, not the pages" — which was the single fact that mattered, and whose
// absence sent the engineer role chasing a nonexistent domain-registration
// problem for five hours.
//
// This process sits between Gatus and Slack. It buffers alerts for a short
// window, groups them by site, and posts ONE message per site per state change
// that leads with scope ("9 of 9 checks"), names the cause class in plain
// English, and says where to look first.
//
// Only SITE endpoints route through here. The fleet's own internal services
// still alert Slack directly, so that if this relay dies, its own health check
// can still say so.

const http = require('node:http');

const PORT = Number(process.env.RELAY_PORT || 8581);
const WINDOW_MS = Number(process.env.RELAY_WINDOW_MS || 45_000);
const SLACK_URL = process.env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage';
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const TZ = process.env.TZ || 'America/New_York';

// site key -> { channel, site, timer, triggered: Map, resolved: Map }
const buffers = new Map();
// site key -> { since: epoch ms, count: n } for endpoints currently down, so a
// RESOLVED message can state how long the site was actually down.
const outages = new Map();

let posted = 0;
let dropped = 0;

function etTime(d = new Date()) {
  return d.toLocaleTimeString('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function humanDuration(ms) {
  if (ms < 60_000) return 'under a minute';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h${String(mins % 60).padStart(2, '0')}m`;
}

// --- cause classification -----------------------------------------------
//
// The whole point of the relay: turn a Go error string into a sentence that
// tells a human (or the engineer role reading the channel) what class of thing
// broke and therefore what to go look at. An unclassified error is passed
// through verbatim rather than guessed at — a wrong diagnosis stated
// confidently is what caused the incident this file is named after.
const CAUSES = [
  {
    match: /no such host|lookup .* on .*:53/i,
    label: 'DNS did not resolve from the monitor',
    hint: 'This is name resolution, not the app. Check the zone\'s Worker '
        + 'custom-domain record before touching site code — a `wrangler deploy` '
        + 'that re-provisions custom domains deletes and re-creates that record, '
        + 'and resolvers then negative-cache the gap for ~30 min.',
  },
  {
    match: /connection refused/i,
    label: 'Connection refused',
    hint: 'Something answered the TCP connect with a reset — edge or origin is '
        + 'up but not listening. Not a content problem.',
  },
  {
    match: /context deadline exceeded|timeout|timed out|i\/o timeout/i,
    label: 'Request timed out',
    hint: 'The endpoint accepted the connection but never finished responding. '
        + 'Look at the Worker\'s logs/CPU limits, not at DNS.',
  },
  {
    match: /certificate|x509|tls/i,
    label: 'TLS/certificate failure',
    hint: 'Certificate or TLS handshake problem — check the zone\'s SSL mode and '
        + 'certificate status.',
  },
  {
    match: /no route to host|network is unreachable/i,
    label: 'Network unreachable from the monitor',
    hint: 'The monitor container itself may have lost egress (VPN rotation). '
        + 'Confirm from the host before treating this as a site outage.',
  },
];

function classify(errors) {
  const joined = errors.join(' ');
  for (const c of CAUSES) if (c.match.test(joined)) return c;
  if (!joined.trim()) {
    return {
      label: 'Unexpected HTTP status',
      hint: 'The request completed but the status code did not match the '
          + 'expected value in the site\'s ops/smoke.yaml. This is a real '
          + 'application/routing failure, not a monitoring artefact.',
    };
  }
  // Deliberately NOT guessed at.
  return { label: joined.slice(0, 200), hint: null };
}

function scopeSentence(down, total) {
  if (total > 1 && down === total) {
    return `Every check for this site failed at once, so the fault is site-wide `
         + `(DNS / edge / worker), not a single page.`;
  }
  if (total > 1) {
    return `The other ${total - down} check${total - down === 1 ? '' : 's'} for `
         + `this site ${total - down === 1 ? 'is' : 'are'} still passing, so this `
         + `is scoped to the page${down === 1 ? '' : 's'} named above, not the site.`;
  }
  return '';
}

function nameList(names, max = 5) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

function buildTriggered(site, entries, total) {
  const cause = classify(entries.flatMap(e => e.errors));
  const now = Date.now();
  const prior = outages.get(site);
  const since = prior ? prior.since : now;
  if (!prior) outages.set(site, { since: now, count: entries.length });
  else prior.count = Math.max(prior.count, entries.length);

  const lines = [
    `*🔴 ${site} — ${entries.length} of ${total} check${total === 1 ? '' : 's'} down*`,
    `*Cause:* ${cause.label}`,
    `*Since:* ${etTime(new Date(since))} ET`,
    `*Down:* ${nameList(entries.map(e => e.name))}`,
  ];
  const scope = scopeSentence(entries.length, total);
  if (scope) lines.push(scope);
  if (cause.hint) lines.push(`*Look at:* ${cause.hint}`);
  return { text: lines.join('\n'), color: '#e01e5a' };
}

function buildResolved(site, entries, total) {
  const prior = outages.get(site);
  const dur = prior ? humanDuration(Date.now() - prior.since) : null;
  const stillDown = prior ? Math.max(0, prior.count - entries.length) : 0;
  if (prior && stillDown === 0) outages.delete(site);
  else if (prior) prior.count = stillDown;

  const head = stillDown > 0
    ? `*🟡 ${site} — ${entries.length} check${entries.length === 1 ? '' : 's'} recovered, `
      + `${stillDown} still down*`
    : `*🟢 ${site} — recovered, ${total} of ${total} checks passing*`;
  const lines = [head];
  if (dur) lines.push(`*Down for:* ${dur}`);
  lines.push(`*Recovered:* ${nameList(entries.map(e => e.name))}`);
  return { text: lines.join('\n'), color: stillDown > 0 ? '#e8912d' : '#2eb67d' };
}

async function postSlack(channel, text, color) {
  if (!SLACK_TOKEN) { dropped += 1; console.warn('[relay] SLACK_BOT_TOKEN unset — dropping'); return; }
  const body = JSON.stringify({
    channel,
    attachments: [{ color, mrkdwn_in: ['text'], text }],
  });
  try {
    const res = await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) { dropped += 1; console.warn(`[relay] slack rejected: ${json.error || res.status}`); }
    else posted += 1;
  } catch (err) {
    dropped += 1;
    console.warn(`[relay] slack post failed: ${err.message}`);
  }
}

function flush(key) {
  const buf = buffers.get(key);
  if (!buf) return;
  buffers.delete(key);
  const { site, channel, total } = buf;
  const trig = [...buf.triggered.values()];
  const res = [...buf.resolved.values()];
  // Resolutions first: if a tick both recovers some and breaks others, the
  // recovery line updates the outage count the trigger line then reports.
  if (res.length) {
    const m = buildResolved(site, res, total);
    postSlack(channel, m.text, m.color);
  }
  if (trig.length) {
    const m = buildTriggered(site, trig, total);
    postSlack(channel, m.text, m.color);
  }
}

function ingest(evt) {
  const site = evt.site || 'unknown';
  const channel = evt.channel;
  if (!channel) { dropped += 1; return; }
  const key = `${channel}|${site}`;
  let buf = buffers.get(key);
  if (!buf) {
    buf = { site, channel, total: evt.total || 1, triggered: new Map(), resolved: new Map() };
    buffers.set(key, buf);
    buf.timer = setTimeout(() => flush(key), WINDOW_MS);
    if (buf.timer.unref) buf.timer.unref();
  }
  buf.total = Math.max(buf.total, evt.total || 1);
  const bucket = evt.resolved ? buf.resolved : buf.triggered;
  // Same endpoint twice in one window: last write wins, no duplicate line.
  bucket.set(evt.name, { name: evt.name, url: evt.url, errors: evt.errors || [] });
}

function parseErrors(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (typeof raw !== 'string') return [];
  const t = raw.trim();
  // Gatus renders an empty error list as the literal "[]" — that is a condition
  // failure (wrong status code), not an absence of information, and classify()
  // depends on telling the two apart.
  if (!t || t === '[]') return [];
  // It renders a populated list Go-style: [err one err two]. There is no
  // separator inside, so the whole thing is kept as one string rather than
  // split on a guess.
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1).trim() : t;
  return inner ? [inner] : [];
}

// The alert body is line-oriented `key: value`, NOT JSON — see
// relay_alert_body() in scripts/generate_config.py. Gatus's error strings
// contain double quotes, which would break a JSON body precisely when an alert
// fires. `errors` is the last key and absorbs the entire remainder of the body,
// so it may contain colons, quotes and newlines without ambiguity.
function parseBody(raw) {
  const out = {};
  const lines = String(raw).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const sep = lines[i].indexOf(': ');
    const bare = lines[i].endsWith(':') && sep === -1;
    if (sep === -1 && !bare) continue;
    const key = bare ? lines[i].slice(0, -1) : lines[i].slice(0, sep);
    if (key === 'errors') {
      out.errors = [lines[i].slice(bare ? key.length + 1 : sep + 2), ...lines.slice(i + 1)]
        .join('\n');
      break;
    }
    out[key] = bare ? '' : lines[i].slice(sep + 2);
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, buffered: buffers.size, posted, dropped }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/alert')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 256 * 1024) req.destroy(); });
  req.on('end', () => {
    try {
      const evt = parseBody(body);
      if (!evt.channel || !evt.site || !evt.name) throw new Error('missing channel/site/name');
      ingest({
        site: evt.site,
        channel: evt.channel,
        name: evt.name,
        url: evt.url,
        total: Number(evt.total) || 1,
        // Gatus substitutes the literal string RESOLVED or TRIGGERED.
        resolved: String(evt.status || '').toUpperCase() === 'RESOLVED',
        errors: parseErrors(evt.errors),
      });
      res.writeHead(202).end('queued');
    } catch (err) {
      dropped += 1;
      console.warn(`[relay] bad payload: ${err.message}`);
      res.writeHead(400).end('bad payload');
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`[relay] listening on :${PORT}, window=${WINDOW_MS}ms`));
}

module.exports = { parseBody, parseErrors, classify, scopeSentence, buildTriggered, buildResolved, humanDuration, ingest, flush, buffers, outages, nameList };
