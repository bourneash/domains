# Data Hub — Centralized Fleet Data Collection

**Date:** 2026-06-28
**Status:** Approved design (pre-implementation)
**Location:** `tools/data-hub/`

## Problem

Five sites (and growing) each run their own external data collection:

- **americastrikes.com, aliencouncil.com, broadwayshowgirls.com, saveusfarms.com** run a
  near-identical `ops/scripts/scrape-feeds.py` against an identical `scraper.json` schema —
  same 200-cap hot cache, same monthly JSONL cold archive, same seen-URL dedup. Only the feed
  list and beat-classification regexes differ.
- **sinderella.org** aggregates structured APIs (ephemeris/moon via PyEphem, NOAA weather/tides,
  FRED economics, USGS earthquakes, Launch Library 2) plus an RSS fallback into a daily markdown
  brief (`ops/llm/roles/brief_builder.py`).
- **saveusfarms.com** additionally pulls NASS (farmland) + EIA (commodity prices) for its War
  Room data (`site/scripts/fetch-data.mjs`).

None of this traffic is routed through a VPN today, despite a fully-built
`tools/vpn-proxy` (dual PIA gluetun exits, iptables killswitch, DNS-over-TLS, autoheal) sitting
idle. Each site scrapes independently, so a source relevant to two sites is fetched and stored
twice. There is no fleet-wide view of what is being collected, from where, or over which path.

## Goals

1. **Collect once, serve many.** A single collector fetches every fleet source exactly once,
   stores it once, and serves filtered slices to any site that wants them.
2. **Categorize via tags + subscriptions.** Sources carry tags; sites declare tag-based
   subscriptions. Adding a feed to a topic instantly offers it to every site subscribed to that
   topic; adding a new site requires zero new scraping.
3. **All collection behind the VPN, fail-closed.** Every source routes through PIA by default
   with the killswitch; if the VPN is down, vpn-policy sources are skipped (never fetched off-VPN).
4. **Full observability in the Fleet Dashboard**, including a per-fetch outbound connection
   ledger (what went where, over which path, when).
5. **Zero site-build disruption.** Sites keep reading the same local cache files; only the
   *scrape step* is swapped for a *pull step*.

## Non-Goals

- Not a multi-host / cross-machine system. Single host (Jesse's box), loopback-bound API.
- Not a packet-level capture tool. The egress ledger is per-fetch, not per-packet (no Wireshark).
- Not changing any site's editorial taxonomy — beat classification stays site-local.
- Not replacing `tools/vpn-proxy` — it is reused as-is.

## Architecture

```
       ┌──────────── tools/data-hub (Docker, behind PIA VPN) ─────────────┐
       │  collector (cron)  →  SQLite store  →  HTTP API :PORT (loopback) │
       │   ├ rss fetcher (reuses scrape-feeds.py logic)                   │
       │   └ dataset fetchers (FRED/NASS/EIA/NOAA/USGS/ephemeris/launches)│
       └──────────────────────────────┬──────────────────────────────────┘
        /items  /datasets  /egress  /health      (host.docker.internal)
  ┌──────────────┬───────────────┬──────────────┬───────────────┐
 americastrikes aliencouncil  broadwayshowgirls saveusfarms   sinderella
  puller→cache   puller→cache    puller→cache    puller+WarRoom  brief-builder
```

### Components

**1. Source Registry — `tools/data-hub/registry/sources.yaml`**

Every source the fleet collects, declared once. A source carries an **array of tags** and is
**fetched once / stored once** regardless of how many sites consume it.

```yaml
sources:
  - id: reuters-world
    type: rss                       # rss | dataset
    url: https://...
    tags: [news, world, defense, markets]   # multi-tag; shared across sites
    policy: vpn                     # vpn (default) | direct
    exit: any                       # us | eu | any
    fetch:
      user_agent: "Mozilla/5.0 ..." # optional per-source overrides
      required_pattern: null        # optional content filter (e.g. aliencouncil VICE rule)

  - id: fred-gdp
    type: dataset
    dataset_key: gdp
    fetcher: fred                   # fred | nass | eia | noaa-alerts | noaa-tides | usgs | ephemeris | launchlib
    params: { series_id: GDPC1 }
    tags: [economy, dataset]
    policy: vpn
    exit: us                        # gov APIs prefer a US exit
```

**Invariant:** `sources.yaml` has exactly one entry per real-world source. A source shared between
americastrikes and saveusfarms appears once with the union of relevant tags. The collector
deduplicates by source `id`; no source is fetched or stored twice per cycle.

**2. Subscriptions — `tools/data-hub/registry/subscriptions.yaml`**

Per-site query against the tag space. This is the site axis of the matrix.

```yaml
subscriptions:
  americastrikes.com:
    items:
      tags_any: [defense, iran, markets, diplomacy, world]
      exclude_sources: []
      limit: 200
      window_hours: 48
    datasets: []
  saveusfarms.com:
    items:
      tags_any: [agriculture, food-policy, farm-economy]
      limit: 200
      window_hours: 48
    datasets: [nass-farmland, eia-commodities]
  sinderella.org:
    items:
      tags_any: [space, science, weird, nature]
      limit: 60
      window_hours: 24
    datasets: [ephemeris, noaa-alerts, noaa-tides, fred-gdp, usgs-quakes, launchlib]
```

A site pulls any item whose tags match `tags_any` (or `tags_all` if specified). Matching is
done server-side by the API.

**3. Collector** (Python, containerized, runs on cron via supercronic)

- Loads registry. For each source: resolve `policy` → pick PIA proxy (US/EU per `exit`) or direct.
- **Leak guard before every VPN fetch** (from `skill-vpn-pia-integration-engineer`): confirm the
  exit IP ≠ Jesse's home IP. If it matches, abort that fetch and flag.
- **Fail-closed:** if the VPN proxy is unreachable/unhealthy, skip all `policy: vpn` sources,
  log the skip, mark them stale. `policy: direct` sources may still run.
- Two fetcher families:
  - `rss` — reuses the proven `scrape-feeds.py` logic (feedparser + httpx), normalize to item rows.
  - `dataset` — typed fetchers (`fred`, `nass`, `eia`, `noaa-alerts`, `noaa-tides`, `usgs`,
    `ephemeris`, `launchlib`) returning structured records.
- Per-source failure isolation: one dead feed does not fail the run (preserves today's graceful
  degradation).
- Writes one **egress event per fetch** to `egress_log` (see store).
- Dedup: global seen-URL set for RSS items; datasets keyed by `(source_id, dataset_key, observed_at)`.

**4. Store — SQLite (`tools/data-hub/data/data-hub.db`, WAL mode)**

WAL allows the API to read concurrently while the collector writes.

```
sources_state(source_id PK, last_fetch_at, last_status, last_error, stale BOOL,
              consecutive_failures INT)

items(id PK, source_id, url UNIQUE, title, summary, content, published_at,
      fetched_at, tags JSON, region, lang, raw JSON)

datasets(id PK, source_id, dataset_key, observed_at, payload JSON, tags JSON,
         UNIQUE(source_id, dataset_key, observed_at))

egress_log(id PK, ts, source_id, target_host, policy, exit_node,    -- us|eu|direct
           exit_ip, status, item_count, byte_count, duration_ms, note)

seen_urls(url PK, first_seen_at)    -- global RSS dedup, capped/pruned
```

Cold retention: items older than the per-subscription window are pruned from the hot path but
retained in `items` until an archive/prune job ages them out (preserving the monthly-archive
behavior sites have today, now centralized).

**5. HTTP API** (FastAPI + uvicorn, bound `127.0.0.1`)

- `GET /items?tags=…&match=any|all&sources=…&exclude=…&since=…&limit=…` → normalized items.
- `GET /datasets/<dataset_key>?since=…&limit=…` → latest structured payloads.
- `GET /sources` → registry + per-source state.
- `GET /subscriptions/<site>` → resolved subscription.
- `GET /egress?since=…&limit=…&policy=…` → outbound connection ledger.
- `GET /health` → collector last-run, per-source freshness, VPN exit IPs + killswitch state,
  fail-closed skip list, item/dataset counts.

Sites in containers reach it via `host.docker.internal:<port>` with
`extra_hosts: ["host.docker.internal:host-gateway"]`.

**6. Per-site puller — `ops/scripts/pull-feeds.py`** (replaces the scrape step)

- GETs the site's slice from `/items` (and `/datasets/*` for sinderella/saveusfarms).
- Applies the site's **local** beat-classification regex (editorial taxonomy stays site-owned).
- Writes the existing `ops/cache/news-feed.json` in the existing format with the existing
  hot-cap / cold-archive / dedup behavior, so the site build is **byte-compatible**.
- Fallback: if the hub API is unreachable, keep the last cache (build never breaks) and log.

**7. VPN integration** — `tools/vpn-proxy` reused unchanged. The collector container resolves
proxy per source via the policy resolver, with `extra_hosts` for `host.docker.internal`.

**8. Fleet Dashboard — new "Data Hub" tab** (`tools/fleet-dashboard`, localhost:4754)

Reads the hub's `/health`, `/egress`, `/sources`, `/subscriptions`:

- Per-source last-fetch + freshness (stale flagged).
- VPN exit IPs (US + EU) + killswitch state; fail-closed skip list.
- **Outbound connection ledger** — reverse-chron feed of `egress_log`: timestamp, source,
  target host, **VPN vs direct**, exit node, exit IP, status, item/byte count. This is the live
  proof of the no-leak guarantee.
- Rendered **source × site matrix** — who pulls what, by tag.
- Item / dataset counts.

## Data Flow

1. Collector cron fires → fetches all sources via per-source VPN policy → normalize + tag →
   upsert into SQLite → write egress events.
2. Each site's cron puller → GET filtered slice → apply local beats → write local cache.
3. Site build reads local cache (unchanged).
4. Dashboard reads `/health` + `/egress` + matrix.

## Error Handling

- **VPN down:** vpn-policy sources skipped, logged, dashboard-flagged stale (fail-closed). No
  off-VPN fetch of a vpn-policy source ever occurs.
- **Leak detected** (exit IP == home IP): that fetch aborts; source flagged.
- **Single source failure:** isolated; run continues; `consecutive_failures` tracked for alerting.
- **Hub API unreachable from a site:** puller keeps last cache; site build unaffected.
- **Gov API blocks PIA IP:** flip that source to `policy: direct` in the registry (explicit,
  logged, shown on dashboard) — the only sanctioned off-VPN path.

## Testing

- **Per-fetcher unit tests** with recorded fixtures (rss + each dataset fetcher).
- **Parity test (migration gate):** for each site, diff `pull-feeds.py` output against the legacy
  `scrape-feeds.py` output until byte-compatible before retiring the old scraper.
- **Killswitch/leak test:** simulate VPN down → assert zero vpn-source fetches and no home-IP
  egress events.
- **API contract tests:** `/items` tag filtering (`any`/`all`), `/datasets`, `/egress`.

## Migration (per-site, reversible, parity-gated)

**Phase 0 — Stand up the hub.** Seed `sources.yaml` with the union of all 5 sites' sources
(deduplicated, multi-tagged) and `subscriptions.yaml` with each site's query. Bring up collector +
API behind the VPN. Verify collection + egress ledger + fail-closed behavior.

**Phase 1 — Migrate per site.** For each site, in this order:
**americastrikes → aliencouncil → broadwayshowgirls → saveusfarms (+War Room) → sinderella (+brief-builder)**

1. Add `ops/scripts/pull-feeds.py`.
2. Run puller alongside the legacy scraper for one cycle; diff outputs (parity gate).
3. Flip cron from scrape → pull.
4. Keep the legacy scraper one more cycle as fallback, then retire it.

saveusfarms also moves its War Room (NASS/EIA) to `/datasets`; sinderella moves its brief-builder
source-fetching to `/datasets` while keeping local vLLM synthesis.

## Stack

Python 3.11 (feedparser, httpx), FastAPI + uvicorn, SQLite (WAL), supercronic cron,
Docker Compose (collector + api containers), behind `tools/vpn-proxy`. Reuses the converged
`scrape-feeds.py` as the RSS fetcher core.

## Decisions Recorded

- **SQLite over flat JSON** — fast tag queries + concurrent read-while-write (WAL).
- **Beat classification stays site-local** — editorial concern; preserves per-site data ownership.
- **Multi-tag, single-store invariant** — one source row, many tags, fetched/stored once, shared
  by all matching subscriptions.
- **VPN: all-via-VPN fail-closed + per-source `direct` allowlist** — strong default, logged
  escape hatch for gov APIs that block VPN IPs.
- **Full scope v1** — news RSS *and* structured datasets, all 5 sites.
