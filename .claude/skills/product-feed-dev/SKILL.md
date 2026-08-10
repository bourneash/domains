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

## Fleet Dashboard integration

Built 2026-08-09: the "Product Feed" tab (`tools/fleet-dashboard`) —
subscriptions + live depth vs. `max_queue_depth`, per-site stats
(queued/claimed/published/rejected/failed), a recent-candidates table.
Server side is `server/product-feed.js` (same degrade-to-`{ok:false}` proxy
pattern as `server/datahub.js`); the panel joins the `product_feed`
external network with `PRODUCTFEED_API: http://product-feed-api:4761` set
in the panel's own `docker-compose.yml` — **both are required**, the env
var alone won't resolve the hostname without the network join. Check this
first if the tab shows "unreachable" but `curl 127.0.0.1:4761/health` from
the host works fine. Editing `server/*.js` needs `docker compose restart
panel`; editing the network/env block needs a full `docker compose up -d`
recreate (network attachments are set at container creation, restart alone
won't pick up a newly-added network). See `fleet-dashboard-dev` for the
general tab-adding pattern this follows.

## Troubleshooting — known issues (found live seeding weirdgirlstore.com, 2026-08-09)

These bit the *first* real end-to-end run of the whole system, all in one
sitting — a strong prior that "looks correct in the code" and "has actually
run successfully in production" are different claims. Check these before
assuming a bug is new.

**Queue never fills / candidates keep getting silently lost:**
- Is the producing site's worker image missing a binary
  `apply_candidate.py`-shaped code depends on? Weirdgirlstore's worker had
  no `convert` (ImageMagick) at all until 2026-08-09 — every image
  candidate had likely been silently crashing at the conversion step since
  that site's cron was containerized. `docker exec <worker> which convert`
  (or whatever binary) is the first check, not an afterthought.
- Is `NODE_OPTIONS=--dns-result-order=ipv4first` set on the producing site's
  worker service? Without it, an Astro + `@astrojs/cloudflare` in-container
  build dies with `ECONNREFUSED 127.0.0.1` at the prerender step — see
  `feedback_astro_cf_prerenderer_needs_ipv4first`. This means the apply
  step's `npm run build` had never actually succeeded from inside that
  container.
- A site's `run-product-scout.sh`/`run-product-publish.sh`-shaped wrapper
  computing its OWN log file at the same path its outer `run-role.sh`
  already tees to (identical `<role>-<timestamp>.log` naming, same
  wall-clock minute) doubles every log line — which can silently
  double-count "new candidates this run" and spawn a judge/apply step
  TWICE per candidate. Caught live: a sweep judged the same 2 candidates 4
  times. If judge-agent spend looks 2x what a run should cost, check for
  duplicate lines in that run's log before suspecting the agent itself.

**A candidate got published with duplicate/orphaned entries (dangling
affiliate.ts line, duplicate /go/ redirect with no matching content):**
- This happens when an apply attempt writes the mechanical files (curio
  json, affiliate.ts, `_redirects`) and THEN fails at a later step (build,
  commit, push) — the write isn't transactional. A retry for the same ASIN
  under a different slug leaves the first attempt's entries orphaned.
  `apply_candidate.py`'s `cleanup_stale_entries_for_asin()` (added
  2026-08-09) handles this automatically on retry now — if you see this
  happen anyway, that function or its call site is the first place to look,
  not a one-off manual cleanup.

**A candidate's search/product-page browsing is VPN-routed but something
downstream isn't:**
- `cc_lib.launch()` proxies the CloakBrowser context correctly, but any
  *separate* HTTP fetch a producing site's scout does outside that browser
  context (e.g. a raw `urllib` re-fetch of a product page or image) does
  NOT inherit that proxy automatically — it needs its own
  `urllib.request.ProxyHandler` wired to
  `social_lib.vpn_session.get_proxy_url()`. Audit every direct
  `urllib`/`requests` call in a site's sourcing pipeline for this, not just
  the browser-driven ones — scout.py's `download_hires_image()` was leaking
  the real host IP this way until fixed.

**General debugging move**: don't trust that a pipeline "works" just
because its code reads correctly and a manual host-side run once
succeeded. Trigger the real containerized path end-to-end
(`docker compose run --rm worker <role>`, watched closely, NOT against a
fake/test candidate — see the "NEVER exercise a real site's
apply_candidate.py" note above for how to do this without contaminating
production) whenever something changed in the container image, compose
env, or wrapper scripts. That's how all five of the issues above surfaced
in a single sitting.
