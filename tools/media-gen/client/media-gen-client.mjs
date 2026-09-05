// media-gen client (Node/ESM) — mirrors media_gen_client.py and
// tools/data-hub-images' client shape.
//
//   import { MediaGenClient } from '.../media-gen-client.mjs';
//   const client = new MediaGenClient();
//   const result = await client.generate({
//     site: '0daynews', prompt: '...', slug: 'some-article',
//   });
//   // result = { id, url, backend, width, height, credit }
//   const bytes = await client.fetchImage(result.id);

export class MediaGenError extends Error {}

export class MediaGenClient {
  constructor({ baseUrl, timeoutMs = 300_000 } = {}) {
    // Workers reach the host through host.docker.internal, while direct host
    // runs use loopback. Linux does not define host.docker.internal on the
    // host itself, so try both defaults and remember whichever one succeeds.
    // An explicit constructor/env URL remains authoritative and is not retried
    // against a different endpoint.
    const configuredUrl = baseUrl || process.env.MEDIA_GEN_API;
    this.baseUrls = (configuredUrl
      ? [configuredUrl]
      : ['http://host.docker.internal:4780', 'http://127.0.0.1:4780']
    ).map(url => url.replace(/\/$/, ''));
    this.baseUrl = this.baseUrls[0];
    this.timeoutMs = timeoutMs;
  }

  async _fetch(path, options) {
    const candidates = [this.baseUrl, ...this.baseUrls.filter(url => url !== this.baseUrl)];
    let lastError;
    for (const candidate of candidates) {
      try {
        const res = await fetch(`${candidate}${path}`, options);
        this.baseUrl = candidate;
        return res;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
      }
    }
    throw new MediaGenError(
      `media-gen unreachable at ${candidates.join(' or ')}: ${lastError?.message || 'fetch failed'}`,
    );
  }

  async _post(path, body) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this._fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new MediaGenError(`${res.status} from media-gen: ${detail}`);
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new MediaGenError(`media-gen request timed out after ${this.timeoutMs}ms`);
      }
      if (err instanceof MediaGenError) throw err;
      throw new MediaGenError(`media-gen unreachable at ${this.baseUrl}: ${err.message}`);
    } finally {
      clearTimeout(t);
    }
  }

  /** @returns {Promise<{id:string,url:string,backend:string,width?:number,height?:number,credit:object}>} */
  async generate({ site, prompt, backend = 'comfyui', profile = 'fast', slug, negativePrompt, width = 1216, height = 832 }) {
    const body = { site, prompt, backend, profile, width, height };
    if (slug) body.slug = slug;
    if (negativePrompt) body.negative_prompt = negativePrompt;
    return this._post('/generate', body);
  }

  /** Fetch the generated image's raw bytes as a Buffer. */
  async fetchImage(id) {
    const res = await this._fetch(`/image/${id}`);
    if (!res.ok) throw new MediaGenError(`${res.status} fetching image ${id}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async health() {
    const res = await this._fetch('/health');
    return res.json();
  }
}
