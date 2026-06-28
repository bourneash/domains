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
