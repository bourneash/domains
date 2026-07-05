# Data Hub Images — HTTP API

The broker's HTTP contract. Any language can consume it directly; this is the
canonical, language-agnostic interface (the Node and Python clients are thin
wrappers over these endpoints). A machine-readable OpenAPI 3.1 document is served
live at `GET /openapi.json` (Swagger UI at `/docs`) and snapshotted in
[`openapi.json`](./openapi.json).

## Base URL & access

- Same host: `http://127.0.0.1:4770`
- Container on the `vpn-proxy_default` Docker network: `http://datahub-images-api:4770`

The service **binds loopback / the internal network only — there is no auth and
it is not exposed off-host by design.** Every external image fetch happens inside
the broker, behind the PIA VPN, fail-closed (a fetch is denied if the VPN probe
fails or an exit IP looks like a home IP). Consumers never reach the public
internet; they ask the broker, the broker fetches.

## The model in one paragraph

You ask for images by **keywords** (an arbitrary subject) or a registered
**topic**. The broker first tries to serve from its shared, deduplicated library;
on a miss it **fetches live through the VPN**, stores the result for reuse, and
returns it in the same response (**synchronous by default**). Reuse is
time-restricted and slug-aware, so the same image isn't handed to the same page
twice. Set `async: true` to queue instead and poll for completion.

---

## `POST /request` — get images

Request body (JSON):

| field | type | required | default | notes |
|---|---|---|---|---|
| `site` | string | **yes** | — | Consuming site key. Drives server-side reuse/dedup. |
| `keywords` | string[] | one of keywords/topic † | `[]` | Subject terms. The bucket is derived from these (lowercased, non-alphanumerics → `-`). |
| `topic` | string | one of keywords/topic † | `null` | Registered topic id, used **verbatim** as the bucket. If given without `keywords`, the topic's configured queries are used to fetch. |

† The server does not 422 if both are omitted — it buckets into `"misc"`. The
supplied clients enforce "at least one of keywords/topic" on the caller's behalf;
raw HTTP consumers should do the same.
| `count` | int | no | `1` | How many images to return. |
| `slug` | string | no | `null` | Page/article slug. Reuse won't repeat an image within a slug. |
| `async` | bool | no | `false` | Queue instead of fetching synchronously. (JSON key is `async`.) |

### Response — sync (default)

`200 OK`. Zero or more images. A `note` appears only when the broker fell short.

```json
{
  "images": [
    {
      "id": "b99dba372a0d…",
      "url": "/image/b99dba372a0d…",
      "credit": { "source": "Unsplash", "photographer": "Daniel Gregoire",
                  "license": "Unsplash License", "url": "https://unsplash.com/photos/…" },
      "license": "Unsplash License",
      "width": 3072,
      "height": 1681
    }
  ]
}
```

- **A genuine miss is still `200`** with `{"images": [], "note": "no new images available for these keywords right now"}` — *not* an error. Treat empty-images as "nothing found," never as a failure.
- **Concurrency cap hit:** `{"images": [...pool-only...], "note": "broker busy — no free fetch slot; retry or use async"}`. Back off and retry, or switch to async.
- A sync request may block while the broker fetches on a miss — bounded by the
  broker's on-demand timeout (default ~25s + one download). Set a generous client timeout.

### Response — async (`"async": true`)

`200 OK` → `{"status": "pending", "request_id": 42}`. Poll `GET /request/{id}`.
(If the pool already satisfied the request, the broker may still return the sync
`{"images": [...]}` shape instead — handle both.)

### `curl`

```bash
curl -s -X POST http://127.0.0.1:4770/request -H 'content-type: application/json' \
  -d '{"site":"americastrikes","keywords":["strait of hormuz","oil tanker"],"count":1,"slug":"hormuz"}'
```

---

## `GET /request/{id}` — poll an async request

`200 OK`, or `404` for an unknown id.

```json
{
  "id": 42, "site": "americastrikes", "topic": "hormuz", "slug": "hormuz",
  "count": 1, "status": "done", "requested_at": "…", "served_at": "…",
  "keywords": ["strait of hormuz oil tanker"],
  "result": { "image_ids": ["b99dba…"] }
}
```

`status` ∈ `pending | done | failed`. On `done`, `result.image_ids` holds the ids
— fetch bytes with `GET /image/{id}`; enrich credit/dimensions via `GET /images`.
On `failed`, `image_ids` is empty and `result.note` explains why.

---

## `GET /image/{id}` — image bytes

`200 OK` with the raw image and `content-type: image/{jpeg|png|webp|gif}`.
`404` if the id or its blob is unknown. This is the download endpoint; derive a
file extension from the response content-type, not from the id.

---

## `GET /images` — library listing

Query params: `site`, `topic`, `status`, `limit` (default `100`). Returns
`{"images": [ {id, credit, width, height, license, source_id, status, …}, … ]}`.
Filtering by `site` returns only images ever assigned to that site.

---

## Diagnostics

| endpoint | returns |
|---|---|
| `GET /health` | `{ok, vpn:{us,eu}, db, generated_at}` — `ok` is true only when the DB is reachable and at least one VPN exit probes. |
| `GET /stats` | `{pool_by_topic, pool_by_source, pool_by_license, requests_by_status}` |
| `GET /sources` | `{sources: [{id, kind, policy, exit, enabled, registry_default, overridden, state}]}` |
| `GET /egress` | `{events:[…]}` — recent outbound fetches (source, status, exit_ip). Params `since`, `limit`, `policy`. |
| `GET /pulls` | `{pulls:[…]}` — recent client pulls. Params `since`, `limit`, `site`. |

## Curation (admin)

| endpoint | effect |
|---|---|
| `POST /sources/{id}/enabled` body `{enabled: bool}` | Enable/disable a source (override the registry default). |
| `POST /images/{id}/blacklist` | Mark an image blacklisted (never served/re-fetched). |
| `POST /images/{id}/reject` | Delete an image from the pool. |

---

## Errors

- Missing image / unknown id / unknown request → `404`.
- Malformed body (wrong types, missing `site`) → `422` (FastAPI validation).
- **No image found is NOT an error** — it's `200` with `images: []` and a `note`.

## Clients

- **Node (ESM):** [`client/datahub-images-client.mjs`](./client/) + the `dhi-images` CLI.
- **Python (stdlib-only):** [`client/datahub_images_client.py`](./client/).

Both wrap this API with retry/backoff, honest empty-on-miss, and download-to-disk.
Any other language can consume the endpoints above directly using
[`openapi.json`](./openapi.json) for codegen.
