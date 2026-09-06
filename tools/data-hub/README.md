# data-hub

Central RSS aggregation service for the fleet. Collects feeds from 71 sources
across 4 site verticals (news/defense, UAP/disclosure, Broadway theater, US
agriculture), stores items in SQLite, and serves them via a FastAPI HTTP API.

All outbound fetch requests are routed through the shared VPN proxy stack
(`tools/vpn-proxy`). VPN is kill-switched: if a node is unreachable the
collector records `status=skipped` and stores no items (fail-closed).

---

## Architecture

```
tools/vpn-proxy/            ← must be running first
  vpn-us  → 127.0.0.1:8181 (HTTP proxy, US exit)
  vpn-eu  → 127.0.0.1:8182 (HTTP proxy, EU exit)

tools/data-hub/
  collector  (supercronic, */30 cron)  → fetches RSS → writes SQLite
  api        (FastAPI/uvicorn :4760)   → reads SQLite → HTTP endpoints
  shared volume: datahub-data:/data/data-hub.db
```

## Data lifecycle (retention)

The store keeps **at most ~1 week of data**. At the end of every collect cycle
the collector runs `store.prune(retention_days)`, deleting rows older than the
horizon from every time-series table — by **ingestion/observation time** (when a
row entered the store), not article publish date, so the DB never grows
unbounded regardless of feed date quirks:

| Table | Pruned on |
|-------|-----------|
| `items` | `fetched_at` |
| `datasets` | `observed_at` |
| `egress_log` | `ts` |
| `pull_log` | `ts` |
| `seen_urls` | `first_seen_at` |

Horizon is `DATAHUB_RETENTION_DAYS` (default **7**). 7 days also matches the
widest subscription window (168h), so nothing servable is pruned. (No `VACUUM`
yet — SQLite/WAL reuses freed pages; revisit if the file size matters.)

## Prerequisites

- `tools/vpn-proxy` running and healthy (`docker ps` shows `vpn-us`, `vpn-eu` as healthy)
- `/home/jesse/projects/domains/.env` with `VPN_PIA_USERNAME`, `VPN_PIA_PASSWORD`

## Bring up

```bash
cd tools/data-hub
docker compose --env-file ../../.env up -d --build
```

## Run one collect cycle immediately

```bash
docker compose --env-file ../../.env exec -T collector python -m datahub collect
```

## Tear down

```bash
docker compose --env-file ../../.env down
```

---

## Datasets (structured data)

Beyond RSS items, the hub collects typed datasets via `type: dataset` sources:

| dataset_key | source | keyless? |
|-------------|--------|----------|
| ephemeris | local PyEphem (moon phase, zodiac, planets) | yes (local) |
| quakes | USGS significant earthquakes | yes |
| weather-alerts | NOAA active alerts | yes |
| kindex / solar-xrays | NOAA SWPC space weather | yes |
| launches | Launch Library 2 upcoming | yes |
| gdp | FRED (needs FRED_API_KEY) | no |
| diesel | EIA v2 (needs EIA_API_KEY) | no |
| corn-yield | USDA NASS (needs NASS_API_KEY) | no |

Served at `GET /datasets` (index) and `GET /datasets/<key>?limit=&since=`.

**Keyed sources auto-skip** with `status=skipped-no-api-key` (visible on `/sources` and the
egress ledger) until the matching key is added to `/home/jesse/projects/domains/.env`. No restart
logic needed — add the key, the next cycle picks it up.

---

## API endpoints

Base URL: `http://127.0.0.1:4760`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | VPN node IPs, source states, item/skipped counts |
| GET | `/items` | Query items by tags, sources, since, limit |
| GET | `/subscriptions/{site}/items` | Items matching a site's subscription query |
| GET | `/subscriptions/{site}` | Resolve a site's subscription config |
| GET | `/sources` | All registered sources with live state + enabled/overridden |
| GET | `/egress` | **Outbound** audit: hub→source fetches (exit IP, policy, status, count) |
| GET | `/pulls` | **Inbound** audit: consumer pulls (site, endpoint, item_count, client IP, when) — params `limit`, `site` |
| GET | `/metrics/gsc-query-pages` | Exact daily GSC query→canonical-page metrics for a site; params `since`, `until`, `limit` |
| POST | `/sources/{id}/enabled` | Runtime enable/disable override (`{"enabled": bool}`) |

### `/items` query params

| Param | Default | Notes |
|-------|---------|-------|
| `tags` | — | Comma-separated; combined with `match` |
| `match` | `any` | `any` = OR; `all` = AND |
| `sources` | — | Include only these source IDs |
| `exclude` | — | Exclude these source IDs |
| `since` | — | ISO-8601 datetime lower bound |
| `limit` | 200 | Max rows returned |

### Examples

```bash
# Health check (shows VPN exit IPs)
curl -s http://127.0.0.1:4760/health | python3 -m json.tool

# Recent defense items
curl -s "http://127.0.0.1:4760/items?tags=defense&limit=5"

# Items for a site subscription
curl -s "http://127.0.0.1:4760/subscriptions/americastrikes.com/items?limit=10"

# Egress audit (outbound: hub → sources)
curl -s "http://127.0.0.1:4760/egress?limit=20"

# Pull audit (inbound: who queried the hub and what they got)
curl -s "http://127.0.0.1:4760/pulls?limit=20"
curl -s "http://127.0.0.1:4760/pulls?site=americastrikes.com"
```

---

## Registry

### `registry/sources.yaml`

71 distinct RSS sources. 1 shared across sites (`breaking-defense`, merged
tags from americastrikes + aliencouncil). Fields:

- `id` — stable kebab-case slug
- `type` — `rss` (dataset type reserved for future plan)
- `url` — feed URL
- `tags` — topic tags (controlled vocabulary; subscriptions match against these)
- `policy` — `vpn` for all sources
- `exit` — `us` for US-gov/wire (DoD, IAEA, EIA, Reuters, AP); `any` otherwise
- `enabled` — optional, default `true`. `enabled: false` is the **declared
  default** kill-switch (see below)
- `fetch.source_name` — display name (verbatim from scraper config)
- `fetch.required_pattern` — optional regex filter on title+summary (VICE only)
- `fetch.full_text` — optional, default `false`. When `true`, the collector
  fetches each new item's article (through the same VPN proxy as the feed)
  and extracts the body with trafilatura into `items.content`, so subscribers
  get real article text instead of just the RSS title/summary. Best-effort:
  any failure (network, non-HTML, too-short/paywall-looking result) leaves
  `content` empty and costs nothing beyond that one fetch. Left off for feeds
  that hand out a redirect/interstitial instead of the article (Google News
  search RSS) since a plain fetch can't resolve those. `/sources` and
  `/health` report `fulltext_attempts`/`fulltext_hits` per source — a source
  stuck at 0 hits after many attempts is paywalled/broken and worth turning
  back off.

### `registry/subscriptions.yaml`

5 subscriber sites:

| Site | Tags | Window | Limit |
|------|------|--------|-------|
| americastrikes.com | defense, iran, diplomacy, markets, domestic, world | 48h | 200 |
| aliencouncil.com | uap, disclosure, sighting, military, science, space, weird | 72h | 100 |
| broadwayshowgirls.com | theater, musicals, awards, industry | 168h | 50 |
| saveusfarms.com | agriculture, farm-economy, land, food-policy, environment | 72h | 100 |
| sinderella.org | weird, uap, science, disclosure, space | 168h | 30 |

### Enabling / disabling a source

A source can be turned off without removing it — the collector skips it entirely
(no VPN probe, no fetch, no egress row) and marks its state `disabled`. Useful
for a feed whose WAF blocks the PIA exit IPs (e.g. `long-war-journal` 503s through
both US + EU) or a flaky source you want to mute.

Two ways, by intent:

- **Permanent default** — set `enabled: false` in `registry/sources.yaml`, then
  rebuild (`docker compose --env-file ../../.env up -d --build`). This is the
  declared default baked into the image.
- **Runtime toggle (no rebuild)** — `POST /sources/{id}/enabled {"enabled": bool}`
  writes a **DB override** (`source_overrides` table in the mounted SQLite, so it
  survives rebuilds) that the collect path overlays on the registry default; it
  takes effect on the next cycle. The override is auto-cleared when set back to
  the registry default. The **Fleet Dashboard → Data Hub tab → Source Freshness**
  panel has a per-source Enable/Disable button that drives this — the normal way
  to flip a source.

```bash
# disable a source at runtime
curl -s -X POST http://127.0.0.1:4760/sources/long-war-journal/enabled \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

`GET /sources` returns each source's effective `enabled`, its `registry_default`,
and whether it's currently `overridden`.

---

## Development

```bash
cd tools/data-hub
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .

# Run tests (no Docker needed — in-memory SQLite)
.venv/bin/python -m pytest -q

# Run API locally (requires vpn-proxy on localhost ports)
.venv/bin/python -m datahub serve

# Run one collect cycle locally
.venv/bin/python -m datahub collect
```

## Logs

```bash
# Collector cron output
docker compose --env-file ../../.env logs -f collector

# API access log
docker compose --env-file ../../.env logs -f api
```
