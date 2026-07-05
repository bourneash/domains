# Data Hub Images — client

The shared way portfolio sites **search / get / retrieve** images through the
[`data-hub-images`](../) broker. One call either serves a matching image from the
VPN-gated shared library or fetches it live on demand, then hands back the image
bytes plus attribution.

- **Zero runtime dependencies** — Node 18+ built-in `fetch` + `node:fs`.
- **Thin transport layer** — the broker owns sourcing, dedup, reuse, and the VPN
  gate. The client owns request shaping, retrieval-to-disk, retry/backoff, and
  honest failure. The client never touches the public internet itself; every
  external fetch happens inside the broker, behind the VPN.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DATAHUB_IMAGES_API` | `http://127.0.0.1:4770` | Broker base URL. In-network use `http://datahub-images-api:4770`. |
| `DATAHUB_IMAGES_TIMEOUT_MS` | `90000` | Timeout for `/request` + image downloads (a sync miss fetches live). |

## Library usage

```js
import { createClient } from '../../tools/data-hub-images/client/datahub-images-client.mjs';

const images = createClient(); // reads DATAHUB_IMAGES_API

// Get one image for a subject and write it to disk. Sync by default: on a pool
// miss the broker fetches live through the VPN and caches it for reuse.
const { images: got, note } = await images.sourceImage({
  site: 'americastrikes',            // required — drives server-side reuse/dedup
  keywords: ['strait of hormuz', 'oil tanker'],
  slug: 'hormuz-oil-shock',          // reuse won't hand the same image to this slug twice
  count: 1,
  destDir: 'site/public/articles/hormuz-oil-shock',
});

if (got.length) {
  const img = got[0];
  // img.path   → the downloaded file
  // img.credit → { source, photographer, license, url }  (for your frontmatter)
  // img.width/height, img.bytes
} else {
  console.warn(`no image: ${note}`); // genuine miss — never throws
}
```

`sourceImage()` **never throws on a miss** — it returns `{ images: [], note }`.
It throws (`DataHubImagesError`) only on transport/protocol failure after retries.

### Lower-level methods

| Method | Returns |
|---|---|
| `request({site, keywords, count, slug, topic, async_})` | Broker JSON verbatim (sync `{images,note}` or async `{status,request_id}`). |
| `pollRequest(id)` / `waitForRequest(id, {intervalMs,timeoutMs})` | Async request status; `waitForRequest` blocks until done/failed. |
| `getImageBuffer(id)` | Image bytes as a Node `Buffer` (guards non-image content-type). |
| `downloadImage(id, destPath)` | Writes bytes to disk (mkdir -p), returns `{path,bytes,contentType}`. |
| `health()` / `stats()` / `sources()` | Broker diagnostics passthrough. |

### Keywords vs topic

Pass `keywords` for an arbitrary subject (the broker derives a bucket and fetches
on demand), **or** `topic` for a registered topic id used verbatim as the bucket.
Provide at least one.

### Sync vs async

Default is **sync**: the call blocks while the broker fetches on a miss (bounded by
the broker's on-demand timeout). Pass `async_: true` to queue instead — the client
polls to completion, then downloads by id (credit is enriched best-effort from the
library listing). Use async for large batches where you don't want to hold a
connection open per image.

## CLI

```bash
# Retrieve one image into a directory
node datahub-images-client.mjs --site americastrikes \
  --keywords "strait of hormuz, oil tanker" --slug hormuz-oil-shock --out ./out

# Machine-readable
node datahub-images-client.mjs --site x --keywords "aircraft carrier" --json

# Diagnostics
node datahub-images-client.mjs --health
node datahub-images-client.mjs --stats
```

Exit codes: `0` at least one image, `3` no image (miss/busy), `2` bad args, `1`
transport error. Run `--help` for the full flag list.

## How a site wraps it

This client returns the **source image + attribution**. Site-specific processing
(resize to `cover.jpg` / `card.jpg`, an editorial-card fallback when the broker
returns nothing, writing frontmatter) stays in the site's own pipeline — see
`site/scripts/find-image.mjs` for the AmericaStrikes shape the broker is designed
to slot into. The client replaces the *sourcing + dedup + reuse* half (Wikimedia /
DVIDS / Unsplash / Pexels search + the local registry) with one `sourceImage()`
call; the site keeps the *processing + fallback + frontmatter* half.

## Tests

```bash
node --test        # network-free; spins a local http stub, no broker/VPN needed
```
