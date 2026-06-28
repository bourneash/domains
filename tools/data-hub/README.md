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
| GET | `/sources` | All registered sources with live state |
| GET | `/egress` | Fetch audit log (exit IP, policy, status per source) |

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

# Egress audit
curl -s "http://127.0.0.1:4760/egress?limit=20"
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
