---
name: product-feed-dev
description: >-
  Develop, extend, operate, and debug product-feed — the fleet's shared,
  tagged product-candidate queue at tools/product-feed (Python 3.11 +
  FastAPI on 127.0.0.1:4761, SQLite, single Docker service, no VPN). It
  decouples a site's own product sourcing/brand-fit judging from actually
  publishing: a site POSTs an accepted candidate with tags, and any
  subscriber whose registry/subscriptions.yaml tags match can claim it, one
  at a time. Use when the user wants to add/modify an API endpoint, change
  the SQLite schema, add or edit a subscription, debug why an item isn't
  routing to the right site, add a stats/dashboard view, or otherwise build
  on or maintain product-feed itself. For wiring a NEW site's producer or
  consumer scripts against it, use the product-feed-onboard-site skill
  instead — this skill is about the hub, that one is about a site's client
  code.
---

# product-feed — Development & Operations

## What it is & where it lives

`tools/product-feed/` (absolute: `/home/jesse/projects/domains/tools/product-feed/`)
is the fleet's shared, tagged product-candidate queue. It exists because a
site's own sourcing pipeline (CloakBrowser search + a `claude -p` brand-fit
and copywriting judgment) is inherently site-specific, but the mechanics
after a candidate is accepted — store it, hand it to whoever wants it, meter
the publish rate — are not. See the `project_weirdgirlstore_product_queue`
memory for the origin story (built 2026-08-09 out of weirdgirlstore.com's
local product-scout queue) and **read the in-repo `tools/product-feed/README.md`**
for the canonical API reference and bring-up commands — this skill is the
extension/operator knowledge that complements it.

### What's plugged into it

```
Site A's scout.py + judge agent (CloakBrowser, brand-fit gate, voice)
        │  POST /candidates  {site_origin, tags, candidate, decision}
        ▼
┌──────────────────────────────┐
│   product-feed (this dir)    │  SQLite @ /data/product-feed.db
│   FastAPI api @ :4761        │  registry/subscriptions.yaml (tag routing)
└──────────────────────────────┘
        │  GET /subscriptions/<site>/next   (atomically claims oldest match)
        ▼
Site A's (or Site B's, if tags overlap and site_origin_allow permits) publisher
        │  runs its own apply/build/commit/push
        ▼
POST /candidates/<id>/published   (or /release on failure — back to queued)
```

Only tenant today: weirdgirlstore.com, both producer and consumer of its own
candidates (`site_origin_allow: [weirdgirlstore.com]` in
`registry/subscriptions.yaml` keeps it exclusive until a second site with
genuinely overlapping tags is onboarded — see product-feed-onboard-site).

## Layout

```
tools/product-feed/
  docker-compose.yml         # 1 service: api. Creates network `product-feed_default`.
  Dockerfile
  registry/
    subscriptions.yaml       # per-site tags_any / site_origin_allow / max_queue_depth
  src/productfeed/
    config.py                # Settings (env-driven) + Subscription loader
    store.py                 # SQLite schema + CRUD, incl. the transactional claim_next()
    api.py                   # create_app() factory — same shape as tools/data-hub's
    __main__.py               # `python -m productfeed serve`
  tests/
    conftest.py              # in-memory sqlite fixture + make_candidate()/make_decision() helpers
    test_store.py
    test_api.py
```

No collector/cron service (unlike data-hub) — product-feed does zero
outbound fetching itself, so no VPN routing either. Everything happens
through the API.

## Data model — `candidates` table (src/productfeed/store.py)

| column | meaning |
|---|---|
| `site_origin` | which site's scout sourced this |
| `asin` | Amazon ASIN if applicable |
| `tags` | JSON list — the routing key, assigned by the producing site (usually its own category taxonomy) |
| `candidate` | JSON — raw sourcing payload, **opaque to the hub** |
| `decision` | JSON — judged catalog copy, **opaque to the hub** |
| `status` | `queued` → `claimed` → `published` (or `rejected`/`failed`, not currently set by anything — reserved for a future explicit-reject endpoint if a consumer ever needs one) |
| `claimed_by` | site that claimed it |
| `created_at` / `claimed_at` / `published_at` | ISO timestamps |

**Do not add columns to validate `candidate`/`decision` internals.** Those
shapes belong to each producing site's own pipeline. If you're tempted to
add a field like `image_url` at the top level, ask whether it actually
belongs in `candidate` instead — the hub should stay a dumb, generic
container plus routing metadata (`site_origin`, `tags`, `status`).

`claim_next()` is the one function that matters for correctness: it runs
inside `BEGIN IMMEDIATE` so two simultaneous claims can't grab the same row.
If you touch it, keep that transaction — this is the only place a race
condition would actually cause a double-publish.

## API (src/productfeed/api.py)

See the README's table for the full list. When adding an endpoint:
- Keep `candidate`/`decision` bodies as plain `dict`, not pydantic models —
  see `CandidateIn`'s docstring in api.py for why.
- Route-level validation should only ever check hub-owned fields
  (`site_origin`, `tags`, `status`) — never reach into `candidate`/`decision`.
- Every mutating endpoint should be idempotent-safe from a caller's retry
  (a site's publisher may retry a `/published` POST after a network blip) —
  `store.mark_status` already no-ops safely on a re-call.

## Registry: `registry/subscriptions.yaml`

One entry per site that pulls from the feed:

```yaml
weirdgirlstore.com:
  tags_any: [occult, novelty, decor, wearable, collectibles]
  site_origin_allow: [weirdgirlstore.com]
  max_queue_depth: 12
```

Loaded once at process start (`config.load_subscriptions`) — **restart the
`api` container after editing this file** (`docker compose restart api` from
`tools/product-feed/`). There's no hot-reload; this mirrors data-hub's
`sources.yaml` behavior (also load-once).

To add a new site's subscription, use the **product-feed-onboard-site**
skill rather than hand-editing this file blind — it covers the tag-sharing
decision (exclusive vs. genuinely shared) that this file's comments flag.

## Bring up / tear down

```bash
cd tools/product-feed
docker compose up -d --build      # creates product-feed_default network + volume
curl http://127.0.0.1:4761/health
docker compose logs -f api
docker compose down               # WARNING: also check `docker compose down -v` doesn't get run
                                   # by habit — that drops the productfeed-data volume (the DB)
```

If you change `registry/subscriptions.yaml` or `src/`, `docker compose up -d
--build` again — the image bakes both in (`COPY registry/` / `COPY src/` in
the Dockerfile), there's no bind mount for either in production.

**Any site whose `docker-compose.yml` references `product_feed:` as an
external network needs this stack's network to exist FIRST.** If you bring
this stack down, that site's worker (`docker compose run --rm worker <role>`)
will fail outright with "network product-feed_default ... not found" — not
degrade gracefully, since Compose resolves external networks at container
creation, before any of the site's own fallback-to-local-disk code ever
runs. Check `docker network ls | grep product-feed` before assuming a site's
worker will start.

## Tests

```bash
cd tools/product-feed
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -e .
.venv/bin/python -m pytest -q
```

17 tests as of the initial build: `store.claim_next`'s tag-matching,
origin-allow-list, oldest-first ordering, and no-double-claim behavior; the
full API surface via FastAPI's `TestClient` with an in-memory sqlite
`conn` fixture (see `tests/conftest.py`). Add tests here — not against the
live `tools/product-feed-api` container — for anything touching `store.py`
or `api.py`.

**NEVER exercise a real site's `apply_candidate.py` (or the wrapper script
that calls it, e.g. weirdgirlstore's `run-product-publish.sh` /
`queue_pull.py`) as a way to test this hub.** That script builds, commits,
AND PUSHES to the site's live repo — it has no dry-run mode. This happened
once already during the initial build (a fake "Test Widget" landed on
weirdgirlstore.com's `main` and had to be reverted). Test product-feed
itself with pytest / curl against a throwaway or the real hub's own SQLite
row — never by letting a site's publish script actually run its apply step
against production to see if the hub "worked."

## Fleet Dashboard integration (not built yet)

data-hub has a "Data Hub" tab (VPN health, egress ledger, source
freshness). product-feed doesn't have an equivalent yet — `GET /stats`
already returns per-site/per-status counts, which is the natural seed for
one. If asked to build this, follow the `fleet-dashboard-dev` skill's
pattern for adding a new tab, not a bespoke page.
