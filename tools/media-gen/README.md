# media-gen

On-demand AI image generation for the whole domains fleet, over HTTP.

`tools/data-hub-images` is the fleet's shared broker for **real** stock/
archival photography — ask it for keywords, it fetches from Unsplash/Pexels/
Wikimedia/etc. behind a VPN. This tool is its sibling for **generated**
images: ask it for a prompt, it renders one, either locally (ComfyUI, fast,
default) or through a real Google account session (Nano Banana / Gemini,
slow, opt-in). Both are meant to sit *alongside* the stock-photo broker as
an additional resource, not replace it — a site's image pipeline should
still try real photography first where that's genuinely the better fit
(e.g. `wikimedia` for actual vendor hardware), and reach for generation
where no real photo could ever be topically relevant (a specific CVE, a
threat-actor campaign, a fictional site's editorial art).

## Why this exists

Built 2026-08-10 in response to a site review note on 0daynews.com: articles
had *an* image (a mature stock-photo pipeline already existed — see
`sites/0daynews.com/site/scripts/find-image.mjs`), but for a headline like
"Metabase CVSS 10 Zero-Day" there is no real photograph of that — the best
a stock-photo query can do is a generic "server room" shot, repeated across
dozens of unrelated CVEs. Generation can produce something that's actually
*about* the specific story instead.

## Quick start

```bash
cd tools/media-gen
pip install -e .
./run.sh                    # backgrounds uvicorn on :4780, tails health
curl http://127.0.0.1:4780/health
```

```bash
curl -s -X POST http://127.0.0.1:4780/generate \
  -H 'content-type: application/json' \
  -d '{"site":"0daynews","prompt":"A cracked blue holographic shield shattering into glowing shards, dark server racks blurred behind it, navy and electric-blue with a hot-red fracture, cinematic volumetric lighting, no words, no letters, no writing, no typography"}'
# -> {"id": "...", "url": "/image/...", "backend": "comfyui", "credit": {...}}
curl -o cover.png http://127.0.0.1:4780/image/<id>
```

## Backends

| Backend | Speed | What it needs | Default |
|---|---|---|---|
| `comfyui` | seconds–~1min, synchronous | Local ComfyUI at `:8188` (already running on this host, dual-A4000, no docker) | **yes** |
| `nanobanana` | 30s–4min, synchronous | CloakBrowser + a live Google session — **opens a real, visible browser window on the host** | no, opt-in per request (`"backend": "nanobanana"`) |

### `comfyui`

Submits a `flux1-schnell-fp8` txt2img graph directly to ComfyUI's native
HTTP API (`POST /prompt`, poll `GET /history`, `GET /view`) — no workflow
files on disk, no CLI subprocess. 4 sampling steps, fast enough to serve
inline within one request. See `src/media_gen/comfyui.py`.

**Prompting gotcha that cost real time to find:** this workflow runs
flux-schnell at `cfg=1.0` (required for that model — raising it degrades
quality badly), and at `cfg=1.0` the KSampler's negative-prompt input is
**mathematically inert**. Don't rely on it to suppress anything. What
actually stops the model rendering a headline-style text overlay on every
image: keep words like *cover*, *headline*, *editorial*, *magazine*, or the
site's own name **out of the positive prompt** — flux reads that framing as
"this is a poster, add a title" and adds one regardless of what the
negative prompt forbids. Describe the visual scene itself, not the artifact
it's going into.

### `nanobanana`

Drives the existing `domains-media-generator-nanobanana` skill's
`generate.py` as a subprocess (writes a one-line `prompts.txt` into a
throwaway theme dir, runs it, runs `dewatermark.py` on the result) rather
than reimplementing the CloakBrowser flow — that script isn't built to be
imported as a clean function, and the working, tested thing already exists.

**Two hard constraints, inherited from the skill, not negotiable:**

1. **Opens a real, visible browser window on the host.** Whatever process
   runs uvicorn needs a live X display — this is not a background/headless
   capability.
2. **The CloakBrowser profile (`/tmp/cloak-driver/profile/`) is a single,
   fleet-wide serialization point** shared with every other skill that logs
   into Google (SEO, GA4, social-setup). Only one generation can run at a
   time, full stop. `src/media_gen/nanobanana.py` enforces that with a file
   lock and returns `429` (not a long hang) if another one is already
   running — but that lock only protects requests that come through *this*
   service. Don't also run the skill by hand while this is live.

## Why this runs as a plain host process, not Docker

Both backends need something a container can't cleanly give them: ComfyUI
needs the GPU process already running on the host (not dockerized itself —
`ps aux | grep ComfyUI`), and Nano Banana needs a real X display for the
visible browser. Containerizing this API and reaching ComfyUI over
`host.docker.internal` would work, but Nano Banana genuinely cannot run
inside a headless container. Simplest to run both backends the same way:
directly on the host, loopback-bound (`127.0.0.1:4780`, matches the fleet's
other `47xx` tools — data-hub `4760`, data-hub-images `4770`).

**Site cron containers reach it via `host.docker.internal`** — the same
`extra_hosts: host.docker.internal:host-gateway` pattern already used for
host-Ollama wiring (see broadwayshowgirls.com's docker-compose.yml). Both
clients default their base URL to `http://host.docker.internal:4780`;
override with `MEDIA_GEN_API` when running/testing from the host directly.

## Storage

Flat files: `data/<id>.png` + `data/<id>.json` (prompt, backend, credit,
site/slug provenance). No database — this generates roughly one image per
request on demand, there's nothing to deduplicate against, and a directory
scan is plenty at that volume. `data/` is gitignored; it's a local cache,
not a fleet-shared library like data-hub-images' pool. Whichever image a
site actually wants gets copied into *that site's own repo* — this tool
doesn't need to remember it after that.

## Clients

- **Python (stdlib-only):** [`client/media_gen_client.py`](./client/media_gen_client.py)
- **Node (ESM):** [`client/media-gen-client.mjs`](./client/media-gen-client.mjs)

Both mirror `tools/data-hub-images`' client shape on purpose.

## Endpoints

| Method | Path | |
|---|---|---|
| `POST` | `/generate` | `{site, prompt, backend?, negative_prompt?, width?, height?, slug?}` → `{id, url, backend, width, height, credit}` |
| `GET` | `/image/{id}` | Raw image bytes. |
| `GET` | `/image/{id}/meta` | Full stored metadata (prompt, backend, credit, provenance). |
| `GET` | `/health` | `{ok, comfyui:{reachable}, nanobanana:{available}}` |
| `GET` | `/backends` | Capability/speed notes per backend, for a caller deciding which to use. |

## Extending

- **Another local model/checkpoint:** `comfyui.py`'s `_workflow()` is the
  only place the graph is built — swap `config.COMFYUI_CHECKPOINT` or add a
  `checkpoint` field to `GenerateRequest` to select per-request.
- **Image-to-image / inpainting / LoRAs:** out of scope for v1 (this is
  txt2img only) — see the `comfyui-studio` skill's other templates
  (`sdxl_img2img.json`, `inpaint.json`, LoRA loader nodes) for the shape to
  extend `_workflow()` toward if a site needs it.
