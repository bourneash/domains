'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);

function validateUrl(value) {
  const url = new URL(String(value));
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error('research URL must use http or https');
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('research URL targets a private host');
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host))
    throw new Error('research URL targets a private address');
  return url;
}

function privateAddress(address) {
  if (net.isIPv4(address))
    return (
      address === '0.0.0.0' ||
      address.startsWith('10.') ||
      address.startsWith('127.') ||
      address.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
    );
  if (net.isIPv6(address))
    return (
      address === '::1' ||
      address === '::' ||
      address.toLowerCase().startsWith('fc') ||
      address.toLowerCase().startsWith('fd') ||
      address.toLowerCase().startsWith('fe80:')
    );
  return true;
}

// This is an observed document summary, not a rendered browser or accessibility verdict.
function summarizeDocument(text, url) {
  const source = String(text || '');
  if (!/<(?:html|body|title|h[1-6])\b/i.test(source)) return null;
  const plain = value =>
    String(value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const body = source.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const headings = [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)]
    .slice(0, 20)
    .map(match => ({ level: Number(match[1]), text: plain(match[2]).slice(0, 160) }));
  const links = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
    .map(match => {
      const href = match[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const raw = href?.[1] ?? href?.[2] ?? href?.[3];
      if (raw === undefined) return null;
      try {
        const target = new URL(raw, url);
        return target.origin === new URL(url).origin &&
          ['http:', 'https:'].includes(target.protocol)
          ? {
              href: target.pathname + target.search + target.hash,
              text: plain(match[2]).slice(0, 100),
            }
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 40);
  return {
    title: plain(source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '').slice(0, 200),
    headings,
    internal_links: links,
    body_text_preview: plain(body).slice(0, 2000),
    limitations:
      'Static response only; links, layout, visibility, keyboard behavior and business outcomes are not validated.',
  };
}

async function fetchOne(root, request, fetchImpl = globalThis.fetch, dnsLookup = dns.lookup) {
  const url = validateUrl(request.url);
  const addresses = await dnsLookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(row => privateAddress(row.address)))
    throw new Error('research URL resolves to a private address');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'user-agent': 'domains-executive-research/1.0' },
    });
    const text = (await response.text()).slice(0, 256 * 1024);
    const id = crypto.randomUUID();
    const row = {
      id,
      url: url.toString(),
      question: String(request.question || ''),
      status: response.ok ? 'completed' : 'http_error',
      http_status: response.status,
      fetched_at: new Date().toISOString(),
      text,
      document: summarizeDocument(text, url),
    };
    const dir = path.join(root, 'tools', 'executive', 'data', 'research');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(row), { mode: 0o600 });
    return {
      id,
      url: row.url,
      question: row.question,
      status: row.status,
      http_status: row.http_status,
      fetched_at: row.fetched_at,
      text_preview: row.document?.body_text_preview || text.slice(0, 2000),
      document: row.document,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run(root, requests, fetchImpl = globalThis.fetch, dnsLookup = dns.lookup) {
  if (!Array.isArray(requests) || requests.length > 10)
    throw new Error('research request limit exceeded');
  const results = [];
  for (const request of requests) {
    try {
      results.push(await fetchOne(root, request, fetchImpl, dnsLookup));
    } catch (error) {
      results.push({
        url: String(request.url || ''),
        question: String(request.question || ''),
        status: 'failed',
        error: error.message,
      });
    }
  }
  return results;
}

function recent(root, limit = 10, { sites = null } = {}) {
  const dir = path.join(root, 'tools', 'executive', 'data', 'research');
  let files;
  try {
    files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
  } catch {
    return [];
  }
  const allowedSites = sites ? new Set(sites.map(site => String(site).toLowerCase())) : null;
  return files
    .map(file => {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (allowedSites && !allowedSites.has(new URL(row.url).hostname.toLowerCase())) return null;
        const document = row.document || summarizeDocument(row.text, row.url);
        return {
          id: row.id,
          url: row.url,
          question: row.question,
          status: row.status,
          http_status: row.http_status,
          fetched_at: row.fetched_at,
          document,
          text_preview: document?.body_text_preview || String(row.text || '').slice(0, 2000),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        (Date.parse(b.fetched_at) || 0) - (Date.parse(a.fetched_at) || 0) ||
        String(a.id).localeCompare(String(b.id))
    )
    .slice(0, Math.max(0, Number(limit) || 0));
}

module.exports = { validateUrl, fetchOne, run, recent, summarizeDocument };
