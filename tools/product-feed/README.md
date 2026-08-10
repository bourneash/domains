# product-feed

Shared, tagged product-candidate queue for the fleet. Decouples **sourcing**
(a site finding + judging a product it might want to carry) from
**publishing** (actually shipping it live) — and, because candidates carry
tags rather than a hardcoded destination site, makes it possible for more
than one site to draw from the same pool without every site getting the
same products.

Built 2026-08-09 out of weirdgirlstore.com's local product-scout publish
queue — see that site's `ops/scripts/product-scout/` for the origin story
(the [`project_weirdgirlstore_product_queue`] memory) and the
`product-feed-onboard-site` skill for wiring a second site to it.

## Why this exists

A site's own scout/judge pipeline (CloakBrowser sourcing + a `claude -p`
brand-fit + copywriting pass) is inherently site-specific — the voice, the
brand-fit gate, the category taxonomy all belong to that one site. What
*isn't* site-specific is the mechanics after a candidate is accepted:
store it, and hand it to whichever site actually wants it, one at a time, on
a metered cadence. That's this service's entire job. It does **no sourcing
and no judging itself** — sites still do that locally and POST the result
here.

## Architecture

```
Site A's scout.py + judge agent (CloakBrowser, brand-fit gate, voice)
        │  POST /candidates  {site_origin, tags, candidate, decision}
        ▼
┌──────────────────────────────┐
│   product-feed (this dir)    │  SQLite store @ /data/product-feed.db
│   FastAPI api @ :4761        │  registry/subscriptions.yaml (tag routing)
└──────────────────────────────┘
        │  GET /subscriptions/<site>/next   (claims oldest matching item)
        ▼
Site A's (or Site B's, if tags overlap and it's allowed) publisher
        │  runs its own apply/build/commit/push
        ▼
POST /candidates/<id>/published   (or /release if the publish attempt failed)
```

No VPN routing needed here (unlike `tools/data-hub`) — product-feed doesn't
make outbound requests at all, it's a pure store-and-route service sites
talk to over the local Docker network.

## Data model

One SQLite table, `candidates`:

| column | meaning |
|---|---|
| `site_origin` | which site's scout sourced this |
| `asin` | Amazon ASIN, if the candidate is Amazon-affiliate-shaped (not required to be) |
| `tags` | JSON list — the routing key. Category tags (`occult`, `novelty`, ...), niche tags, whatever the producing site's brand-fit gate assigns |
| `candidate` | JSON — the raw sourcing payload (title/price/rating/image URL/...), opaque to the hub |
| `decision` | JSON — the judged catalog copy (name/tagline/body/category/...), opaque to the hub |
| `status` | `queued` → `claimed` → `published` (or `rejected`/`failed`) |
| `claimed_by` | which site claimed it |

The hub deliberately does not validate the internals of `candidate`/`decision`
— those shapes are owned by each site's own pipeline (see
`sites/weirdgirlstore.com/ops/scripts/product-scout/apply_candidate.py` for
what weirdgirlstore expects a `decision` to contain). Validating that here
would just duplicate each producer's schema and break the moment a site adds
a field.

## Routing: `registry/subscriptions.yaml`

```yaml
weirdgirlstore.com:
  tags_any: [occult, novelty, decor, wearable, collectibles]
  site_origin_allow: [weirdgirlstore.com]   # exclusive — no other producer's items can be claimed here
  max_queue_depth: 12
```

- `tags_any` — a site claims the oldest **queued** candidate whose `tags`
  intersect this list.
- `site_origin_allow` (optional) — additionally restrict to candidates
  produced by listed sites. Omit it to let genuinely shared tags (e.g. two
  sites both tagging `gothic`) be claimed by whichever subscriber asks
  first — first claim wins, no double-serving (`claim_next` is
  transactional).
- `max_queue_depth` — informational. Producers should call
  `GET /subscriptions/<site>/depth` before sourcing more and back off at/
  above this number.

See the **product-feed-onboard-site** skill before adding a new site here —
it walks through picking tags and deciding whether to share or stay
exclusive.

## API

Base URL: `http://127.0.0.1:4761` (loopback-only on the host; sites reach it
over the `product-feed_default` Docker network by container name
`product-feed-api`).

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ok, subscriptions: [...]}` |
| POST | `/candidates` | Producer pushes a judged candidate. Body: `{site_origin, tags, candidate, decision}` → `{id, status: "queued"}` |
| GET | `/candidates/{id}` | Fetch one candidate |
| GET | `/candidates?status=&site_origin=&tag=&limit=` | List/debug |
| GET | `/subscriptions/{site}/next` | Atomically claim the oldest matching candidate for `site`. `{item: {...} | null}` |
| GET | `/subscriptions/{site}/depth` | `{site, depth, max_queue_depth}` — queued+claimed count matching this site's tags |
| POST | `/candidates/{id}/published` | Mark published (call after your apply/build/commit/push succeeds) |
| POST | `/candidates/{id}/release` | Publish attempt failed downstream — put it back in `queued` for retry |
| GET | `/stats` | Per-site, per-status counts |

## Bring up

```bash
cd tools/product-feed
docker compose up -d --build
curl http://127.0.0.1:4761/health
```

This creates the `product-feed_default` network. Bring this stack up
**before** restarting a site's worker that needs to join it.

## Tests

```bash
cd tools/product-feed
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -e .
.venv/bin/python -m pytest -q
```

## Consuming this from a site

Don't hand-roll the HTTP calls — see the **product-feed-dev** skill for
extending this service, and **product-feed-onboard-site** for wiring a
site's producer (`queue_add`-shaped POST) and/or consumer (`queue_pull`-shaped
GET .../next → apply → published/release) scripts. weirdgirlstore.com's
`ops/scripts/product-scout/queue_add.py` and `queue_pull.py` are the
reference implementation — hub-first with a local-disk fallback so a site
keeps working even if this service is down or not yet brought up.
