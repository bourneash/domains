#!/usr/bin/env node
// Data Hub Images — client library + CLI.
//
// The single, shared way portfolio sites talk to the data-hub-images broker
// (tools/data-hub-images). Sites call this to SEARCH/GET/RETRIEVE images through
// the VPN-gated, multi-source pool: one request either serves a matching image
// from the shared library or fetches it live on demand, then hands back the
// image bytes plus attribution.
//
// Zero runtime dependencies — Node 18+ built-in fetch + node:fs only. Import it
// as a library, or run it as a CLI (see --help). It is a THIN transport layer:
// the broker owns sourcing, dedup, reuse and the VPN gate; the client owns
// request shaping, retrieval-to-disk, retry/backoff, and honest failure.
//
// The broker binds loopback (127.0.0.1:4770) or, in-network, datahub-images-api:4770.
// Point the client with DATAHUB_IMAGES_API. It NEVER reaches the public internet
// itself — every external fetch happens inside the broker, behind the VPN.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = process.env.DATAHUB_IMAGES_API || 'http://127.0.0.1:4770';
// A sync /request may fetch live on a pool miss (the broker caps it at
// on_demand_timeout_s + one download); give it real headroom. Image bytes can
// be several MB. Light metadata calls get a short timeout.
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.DATAHUB_IMAGES_TIMEOUT_MS) || 90_000;
const DEFAULT_META_TIMEOUT_MS = 15_000;

/** Raised for transport/protocol failures (network, non-2xx, bad JSON). A
 *  request that simply found no image is NOT an error — it resolves normally
 *  with an empty `images` array and a `note`. */
export class DataHubImagesError extends Error {
  constructor(message, { status, cause, retryable } = {}) {
    super(message);
    this.name = 'DataHubImagesError';
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
    // Deterministic client-side errors (arg validation) set retryable=false so
    // the sourceImage() retry loop surfaces them immediately instead of sleeping.
    if (retryable !== undefined) this.retryable = retryable;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class DataHubImagesClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]     Broker base URL. Default DATAHUB_IMAGES_API or http://127.0.0.1:4770.
   * @param {number} [opts.timeoutMs]   Per-request timeout for /request + image downloads (ms).
   * @param {number} [opts.metaTimeoutMs] Per-request timeout for light calls (/health, /stats, poll).
   * @param {number} [opts.retries]     Retry attempts on transport 5xx/network AND on a "busy" note. Default 2.
   * @param {number} [opts.retryBaseMs] Base backoff between retries (ms). Default 750. Grows *2 each attempt.
   * @param {string} [opts.userAgent]   User-Agent header sent to the broker.
   * @param {typeof fetch} [opts.fetch] Injectable fetch (for tests). Default global fetch.
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.metaTimeoutMs = opts.metaTimeoutMs ?? DEFAULT_META_TIMEOUT_MS;
    this.retries = opts.retries ?? 2;
    this.retryBaseMs = opts.retryBaseMs ?? 750;
    this.userAgent = opts.userAgent || 'datahub-images-client/1.0';
    this._fetch = opts.fetch || globalThis.fetch;
    // Seam for tests to avoid real backoff sleeps.
    this._sleep = opts._sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (typeof this._fetch !== 'function') {
      throw new DataHubImagesError('global fetch unavailable — Node 18+ required, or pass opts.fetch');
    }
  }

  async _fetchWithTimeout(url, { timeoutMs, ...init } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.timeoutMs);
    try {
      return await this._fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new DataHubImagesError(`request to ${url} timed out after ${timeoutMs ?? this.timeoutMs}ms`, { cause: err });
      }
      throw new DataHubImagesError(`network error contacting ${url}: ${err?.message || err}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async _getJson(pathname, { timeoutMs } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const res = await this._fetchWithTimeout(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': this.userAgent },
      timeoutMs: timeoutMs ?? this.metaTimeoutMs,
    });
    if (!res.ok) {
      throw new DataHubImagesError(`GET ${pathname} → HTTP ${res.status}`, { status: res.status });
    }
    try {
      return await res.json();
    } catch (err) {
      throw new DataHubImagesError(`GET ${pathname} returned invalid JSON`, { cause: err });
    }
  }

  /**
   * Low-level POST /request. Returns the broker's JSON verbatim:
   *   sync  → { images: [ {id,url,credit,license,width,height}, ... ], note? }
   *   async → { status: "pending", request_id: <int> }
   * Never retries on a "busy" note here — that policy lives in sourceImage().
   *
   * @param {object} body
   * @param {string} body.site        Consuming site key (required). Drives reuse/dedup server-side.
   * @param {string[]|string} [body.keywords] Subject terms. Required unless `topic` is given.
   * @param {number} [body.count=1]   How many images to return.
   * @param {string} [body.slug]      Article/page slug — reuse avoids handing the same image to the same slug.
   * @param {string} [body.topic]     Registered topic id, used verbatim as the bucket instead of keyword-derived.
   * @param {boolean} [body.async_=false] Queue instead of fetching synchronously.
   */
  async request(body = {}) {
    const { site, keywords, topic, count } = validateRequestArgs(body);
    const payload = { site, keywords, count };
    if (body.slug) payload.slug = body.slug;
    if (topic) payload.topic = topic;
    if (body.async_) payload.async = true; // JSON key is "async" (broker aliases it)

    const url = `${this.baseUrl}/request`;
    const res = await this._fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.userAgent },
      body: JSON.stringify(payload),
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) {
      throw new DataHubImagesError(`POST /request → HTTP ${res.status}`, { status: res.status });
    }
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new DataHubImagesError('POST /request returned invalid JSON', { cause: err });
    }
    if (!isPlainObject(json)) {
      throw new DataHubImagesError('POST /request returned a non-object body');
    }
    return json;
  }

  /** GET /request/{id} — poll an async request. Returns the full status row incl.
   *  `status` ("pending"|"done"|"failed") and `result.image_ids`. */
  async pollRequest(requestId) {
    if (!Number.isInteger(requestId)) {
      throw new DataHubImagesError('pollRequest: requestId must be an integer');
    }
    return this._getJson(`/request/${requestId}`);
  }

  /** Poll an async request until it leaves "pending" or the deadline passes.
   *  Resolves with the terminal status row; throws only on timeout/transport. */
  async waitForRequest(requestId, { intervalMs = 2000, timeoutMs = 120_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // Loop guard is time-based; each poll is a fresh short request.
    for (;;) {
      const row = await this.pollRequest(requestId);
      if (row?.status && row.status !== 'pending') return row;
      if (Date.now() >= deadline) {
        throw new DataHubImagesError(`request ${requestId} still pending after ${timeoutMs}ms`);
      }
      await this._sleep(intervalMs);
    }
  }

  /** Fetch raw image bytes for an id. Returns a Node Buffer. */
  async getImageBuffer(imageId) {
    if (!imageId || typeof imageId !== 'string') {
      throw new DataHubImagesError('getImageBuffer: imageId is required (string)');
    }
    const url = `${this.baseUrl}/image/${encodeURIComponent(imageId)}`;
    const res = await this._fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'user-agent': this.userAgent },
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) {
      throw new DataHubImagesError(`GET /image/${imageId} → HTTP ${res.status}`, { status: res.status });
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      throw new DataHubImagesError(`GET /image/${imageId} returned non-image content-type "${contentType}"`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    buf.contentType = contentType;
    return buf;
  }

  /** Download an image to disk, creating parent dirs. Returns {path, bytes, contentType}. */
  async downloadImage(imageId, destPath) {
    if (!destPath || typeof destPath !== 'string') {
      throw new DataHubImagesError('downloadImage: destPath is required (string)');
    }
    const buf = await this.getImageBuffer(imageId);
    await fs.mkdir(path.dirname(path.resolve(destPath)), { recursive: true });
    await fs.writeFile(destPath, buf);
    return { path: destPath, bytes: buf.length, contentType: buf.contentType || '' };
  }

  async health() { return this._getJson('/health'); }
  async stats() { return this._getJson('/stats'); }
  async sources() { return this._getJson('/sources'); }

  /**
   * High-level: get images for a subject and (optionally) write them to disk.
   * This is what most site code should call. Sync by default: on a pool miss the
   * broker fetches live through the VPN. Handles the broker's transient "busy"
   * note and transport 5xx with bounded backoff. Returns an ARRAY of results —
   * empty (never throwing) when the broker genuinely has nothing to offer.
   *
   * @param {object} args
   * @param {string} args.site
   * @param {string[]|string} [args.keywords]
   * @param {string} [args.topic]
   * @param {number} [args.count=1]
   * @param {string} [args.slug]
   * @param {boolean} [args.async_=false] Use the queue+poll path instead of sync fetch.
   * @param {string} [args.destDir]  If set, each returned image is written here.
   * @param {(img, index) => string} [args.filename]  Name within destDir (default `<id>.<ext>`).
   * @param {object} [args.waitOpts] Passed to waitForRequest when async_.
   * @returns {Promise<{images: Array<{id,url?,credit?,width?,height?,path?,bytes?}>, note?: string, requestId?: number}>}
   */
  async sourceImage(args = {}) {
    const { destDir, filename, async_ = false, waitOpts } = args;
    // Fail fast on bad args — deterministic, so never enter the retry loop with them.
    validateRequestArgs(args);

    if (async_) {
      const created = await this.request({ ...args, async_: true });
      const requestId = created?.request_id;
      if (!Number.isInteger(requestId)) {
        // Broker satisfied it inline or returned an unexpected shape — fall through
        // to whatever images it handed back, if any.
        const inline = await this._materialize(created?.images || [], { destDir, filename });
        return { images: inline, note: created?.note, requestId: undefined };
      }
      const row = await this.waitForRequest(requestId, waitOpts || {});
      const ids = row?.result?.image_ids || [];
      const note = row?.note || row?.result?.note ||
        (row?.status === 'failed' ? 'request failed — no image produced' : undefined);
      // Async poll returns ids only; enrich credit best-effort from the library.
      const enriched = await this._enrichByIds(ids, args.site);
      const images = await this._materialize(enriched, { destDir, filename });
      return { images, note: images.length ? undefined : note, requestId };
    }

    // Sync path with busy/transport retry.
    let lastNote;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let body;
      try {
        body = await this.request(args);
      } catch (err) {
        // Retry only transient transport failures (5xx / network / timeout).
        // A validation error (retryable:false) or a 4xx is deterministic — rethrow now.
        const nonRetryable = err instanceof DataHubImagesError &&
          (err.retryable === false || (typeof err.status === 'number' && err.status < 500));
        const transient = !nonRetryable;
        if (transient && attempt < this.retries) {
          await this._sleep(this.retryBaseMs * 2 ** attempt);
          continue;
        }
        throw err;
      }
      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length) {
        const materialized = await this._materialize(images, { destDir, filename });
        return { images: materialized, note: body.note };
      }
      // No images. If the broker signalled "busy" (no free fetch slot), back off
      // and retry; a genuine miss returns immediately with note preserved.
      lastNote = body.note;
      const busy = typeof body.note === 'string' && /busy|no free fetch slot/i.test(body.note);
      if (busy && attempt < this.retries) {
        await this._sleep(this.retryBaseMs * 2 ** attempt);
        continue;
      }
      return { images: [], note: lastNote };
    }
    return { images: [], note: lastNote };
  }

  /** Best-effort: turn bare image ids into {id, credit, width, height} via GET /images. */
  async _enrichByIds(ids, site) {
    if (!ids?.length) return [];
    let index = new Map();
    try {
      const q = site ? `?site=${encodeURIComponent(site)}&limit=500` : '?limit=500';
      const listing = await this._getJson(`/images${q}`);
      const items = listing?.images || listing?.items || [];
      for (const it of items) if (it?.id) index.set(it.id, it);
    } catch {
      // Listing is an enrichment nicety; ids alone are enough to download bytes.
    }
    return ids.map((id) => index.get(id) || { id });
  }

  /** Optionally write each image to destDir; always returns normalized objects. */
  async _materialize(images, { destDir, filename }) {
    const out = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i] || {};
      const rec = {
        id: img.id,
        url: img.url,
        credit: img.credit,
        license: img.license,
        width: img.width,
        height: img.height,
      };
      if (destDir && img.id) {
        // Fetch first so the extension can follow the real content-type
        // (the broker serves jpg/png/webp/gif). A caller-supplied filename wins as-is.
        const buf = await this.getImageBuffer(img.id);
        const name = filename ? filename(img, i) : `${img.id}.${extForContentType(buf.contentType)}`;
        const dest = path.join(destDir, name);
        await fs.mkdir(path.dirname(path.resolve(dest)), { recursive: true });
        await fs.writeFile(dest, buf);
        rec.path = dest;
        rec.bytes = buf.length;
        rec.contentType = buf.contentType || '';
      }
      out.push(rec);
    }
    return out;
  }
}

/** Validate + normalize request args. Throws DataHubImagesError (no `.status` —
 *  these are deterministic client bugs, so callers must NOT retry them). Returns
 *  the cleaned `{site, keywords, topic, count}`. */
export function validateRequestArgs(body = {}) {
  const site = body.site;
  if (!site || typeof site !== 'string') {
    throw new DataHubImagesError('request: `site` is required (string)', { retryable: false });
  }
  const keywords = normalizeKeywords(body.keywords);
  const topic = body.topic;
  if (!keywords.length && !topic) {
    throw new DataHubImagesError('request: provide `keywords` (non-empty) or a registered `topic`', { retryable: false });
  }
  const count = body.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new DataHubImagesError('request: `count` must be a positive integer', { retryable: false });
  }
  return { site, keywords, topic, count };
}

const EXT_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Map an image content-type to a file extension; unknown → `img`. */
export function extForContentType(contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE[ct] || 'img';
}

/** Normalize keywords into a clean string[] from an array or a comma/space string. */
export function normalizeKeywords(keywords) {
  if (Array.isArray(keywords)) {
    return keywords.map((k) => String(k).trim()).filter(Boolean);
  }
  if (typeof keywords === 'string') {
    return keywords.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean);
  }
  return [];
}

/** Convenience factory. */
export function createClient(opts) {
  return new DataHubImagesClient(opts);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `datahub-images-client — query the data-hub-images broker

Usage:
  datahub-images-client --site <site> --keywords "a,b,c" [options]
  datahub-images-client --health | --stats | --sources

Options:
  --site <s>          Consuming site key (required for image requests)
  --keywords "a,b"    Comma/space-separated subject terms (or repeat --keyword)
  --topic <t>         Registered topic id (bucket) instead of keyword-derived
  --count <n>         Number of images to return (default 1)
  --slug <s>          Page/article slug (reuse avoids repeating within a slug)
  --out <dir>         Download returned images into this directory
  --async             Queue the request and poll for completion
  --base <url>        Broker base URL (default $DATAHUB_IMAGES_API or 127.0.0.1:4770)
  --json              Emit machine-readable JSON only
  --health|--stats|--sources   Print broker diagnostics and exit
  -h, --help          This help

Exit codes: 0 = at least one image; 3 = no image (miss/busy); 2 = bad args; 1 = transport error.

Env: DATAHUB_IMAGES_API, DATAHUB_IMAGES_TIMEOUT_MS`;

function parseArgs(argv) {
  const a = { keywords: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case '-h': case '--help': a.help = true; break;
      case '--json': a.json = true; break;
      case '--async': a.async_ = true; break;
      case '--health': a.health = true; break;
      case '--stats': a.stats = true; break;
      case '--sources': a.sources = true; break;
      case '--site': a.site = next(); break;
      case '--topic': a.topic = next(); break;
      case '--slug': a.slug = next(); break;
      case '--out': a.out = next(); break;
      case '--base': a.base = next(); break;
      case '--count': {
        const v = Number(next());
        if (!Number.isInteger(v) || v < 1) { a._error = '--count must be a positive integer'; }
        else { a.count = v; }
        break;
      }
      case '--keyword': a.keywords.push(next()); break;
      case '--keywords': a.keywords.push(...normalizeKeywords(next())); break;
      default:
        if (t.startsWith('-')) { a._error = `unknown flag: ${t}`; }
        else { a.keywords.push(t); } // bare word = keyword
    }
  }
  return a;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.help) { console.log(HELP); return 0; }
  if (a._error) { console.error(a._error + '\n\n' + HELP); return 2; }

  const client = new DataHubImagesClient({ baseUrl: a.base });

  try {
    if (a.health || a.stats || a.sources) {
      const which = a.health ? 'health' : a.stats ? 'stats' : 'sources';
      const data = await client[which]();
      console.log(JSON.stringify(data, null, a.json ? 0 : 2));
      return 0;
    }

    if (!a.site) { console.error('error: --site is required\n\n' + HELP); return 2; }
    if (!a.keywords.length && !a.topic) {
      console.error('error: provide --keywords or --topic\n\n' + HELP); return 2;
    }

    const result = await client.sourceImage({
      site: a.site,
      keywords: a.keywords,
      topic: a.topic,
      slug: a.slug,
      count: Number.isInteger(a.count) ? a.count : 1,
      async_: a.async_,
      destDir: a.out,
    });

    if (a.json) {
      console.log(JSON.stringify(result));
    } else if (result.images.length) {
      for (const img of result.images) {
        const by = img.credit ? ` — ${img.credit.source} / ${img.credit.photographer}` : '';
        const where = img.path ? `  → ${img.path} (${img.bytes}b)` : '';
        console.log(`✓ ${img.id?.slice(0, 12)}  ${img.width || '?'}x${img.height || '?'}${by}${where}`);
      }
    } else {
      console.error(`✗ no image — ${result.note || 'broker returned nothing'}`);
    }
    return result.images.length ? 0 : 3;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

// Run as CLI only when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
