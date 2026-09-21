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
      text_preview: text.slice(0, 2000),
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

function recent(root, limit = 10) {
  const dir = path.join(root, 'tools', 'executive', 'data', 'research');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter(x => x.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
  return files
    .map(file => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        return {
          id: r.id,
          url: r.url,
          question: r.question,
          status: r.status,
          fetched_at: r.fetched_at,
          text_preview: String(r.text || '').slice(0, 2000),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { validateUrl, fetchOne, run, recent };
