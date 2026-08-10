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
    // host.docker.internal from inside a site's cron container (same
    // extra_hosts pattern already used for host-Ollama wiring); localhost
    // when run directly on the host (e.g. a local `npm run build`).
    this.baseUrl = (baseUrl || process.env.MEDIA_GEN_API || 'http://host.docker.internal:4780').replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async _post(path, body) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
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
  async generate({ site, prompt, backend = 'comfyui', slug, negativePrompt, width = 1216, height = 832 }) {
    const body = { site, prompt, backend, width, height };
    if (slug) body.slug = slug;
    if (negativePrompt) body.negative_prompt = negativePrompt;
    return this._post('/generate', body);
  }

  /** Fetch the generated image's raw bytes as a Buffer. */
  async fetchImage(id) {
    const res = await fetch(`${this.baseUrl}/image/${id}`);
    if (!res.ok) throw new MediaGenError(`${res.status} fetching image ${id}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }
}
