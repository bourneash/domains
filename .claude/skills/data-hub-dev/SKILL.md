---
name: data-hub-dev
description: >-
  Develop, extend, operate, and debug the data-hub — the fleet's centralized,
  VPN-routed data collection service at tools/data-hub (Python 3.11 + FastAPI on
  127.0.0.1:4760, SQLite, Docker collector+api behind tools/vpn-proxy). It scrapes
  every site's RSS ONCE behind PIA (tagged, multi-tag, stored once), serves
  structured datasets (ephemeris/quakes/space-weather/alerts/launches/FRED/NASS/EIA),
  exposes a per-fetch egress ledger, and is consumed by per-site pullers
  (sites/<host>/ops/scripts/pull-feeds.py) + the Fleet Dashboard "Data Hub" tab.
  Use when the user wants to add/modify a source or dataset, onboard a new
  subscriber site, change tags/subscriptions, debug the VPN/killswitch or egress,
  migrate a site to the hub, or otherwise build on / maintain the data-hub.
---

# data-hub — Development & Operations

## What it is & where it lives

`tools/data-hub/` (absolute: `/home/jesse/projects/domains/tools/data-hub/`)
is the fleet's **centralized data-collection service**. Instead of each site
running its own scraper, the hub fetches every source **once, behind a VPN**,
stores it **once** (SQLite), and lets any site pull the full dataset or any
tagged slice over an HTTP API. A source can carry **multiple tags** and is
never scraped or stored twice.

It was built across four plans (specs/plans under
`docs/superpowers/specs/2026-06-28-data-hub-design.md` and
`docs/superpowers/plans/2026-06-28-data-hub-{1-core,2-datasets,3-dashboard,4-migration}.md`).
Background + decisions live in the `project_data_hub` memory. **Read the
in-repo `tools/data-hub/README.md` for the canonical run/curl commands** — this
skill is the operator + extension knowledge that complements it.

### What's plugged into it (the whole system)

```
  RSS feeds + dataset APIs                          (the internet)
        │  (fetched ONCE, behind PIA via tools/vpn-proxy, fail-closed)
        ▼
  ┌──────────────────────────────┐
  │  data-hub  (tools/data-hub)  │  SQLite store @ /data/data-hub.db (WAL)
  │  collector (*/30) + api      │  HTTP API @ 127.0.0.1:4760
  └──────────────────────────────┘
        │ GET /subscriptions/<host>/items        │ GET /datasets/<key>
        ▼                                         ▼
  per-site pullers                          sinderella brief_builder.py
  sites/<host>/ops/scripts/pull-feeds.py    (6 keyless signals from the hub)
  → write ops/cache/news-feed.json
        │
        ▼  (also)
  Fleet Dashboard "Data Hub" tab (tools/fleet-dashboard) — VPN health,
  per-connection egress ledger, freshness, datasets, source×site matrix.
```

## Layout

```
tools/data-hub/
  docker-compose.yml      # 2 services: datahub-collector (supercronic) + datahub-api; external net vpn-proxy_default
  Dockerfile              # python:3.11-slim; COPYs src/ + registry/ into the image, pip install -e .
  crontab.docker          # `*/30 * * * * python -m datahub collect`  (collector schedule)
  pyproject.toml          # package `datahub`, pytest config (tests/)
  requirements.txt        # httpx, fastapi, uvicorn, pydantic, feedparser, pyyaml, ephem, …
  README.md               # canonical bring-up / curl / dev commands
  registry/
    sources.yaml          # ONE entry per distinct feed/dataset (tags[], policy, exit, fetch.source_name)
    subscriptions.yaml    # ONE entry per subscriber site (tags_any/tags_all, limit, window_hours, datasets[])
  src/datahub/
    __main__.py           # CLI: `python -m datahub collect` (one cycle) | `serve` (API, default)
    config.py             # Settings.from_env(); Source/Subscription/ItemsQuery models; DEFAULT_HOME_IPS
    store.py              # SQLite: items, datasets_state, sources_state, egress_log; upsert/query/record_egress
    vpn.py                # probe_exit_ip() (HTTPS checkip), plan_fetch() → FetchPlan (fail-closed)
    fetch_rss.py          # RSS fetch + parse → items
    collector.py          # run_cycle(): for each source → plan_fetch → fetch → upsert → record egress
    api.py                # FastAPI create_app(): /items /subscriptions /datasets /egress /sources /health
    datasets/
      __init__.py         # FETCHERS registry + _get_json (with _redact) + DatasetUnavailable
      ephemeris.py usgs.py noaa_alerts.py noaa_swpc.py noaa_tides.py launchlib.py   # keyless
      fred.py eia.py nass.py                                                        # keyed
  tests/                  # 54 tests, in-memory SQLite, NO Docker needed
```

## Deploy mechanics — THE thing to get right

`src/` and `registry/` are **COPYed into the image** (NOT bind-mounted, unlike
the Fleet Dashboard). So code or registry edits do **not** take effect until you
rebuild. There is a `.venv` for running the test suite without Docker.

| You changed… | How to ship / check it | Why |
|---|---|---|
| any `src/**.py` logic | `.venv/bin/python -m pytest -q` (fast, no Docker, in-memory SQLite) **then** rebuild | Tests gate logic; image must be rebuilt to run it live. |
| `src/**.py` or `registry/*.yaml` (to go live) | `cd tools/data-hub && docker compose --env-file ../../.env up -d --build` | Rebuilds the image for **both** services (collector + api) and recreates them. |
| just want fresh data now | `docker compose --env-file ../../.env exec -T collector python -m datahub collect` | Runs one collect cycle immediately (doesn't wait for the `*/30` cron). |
| inspect what the API serves | `curl -s http://127.0.0.1:4760/health | python3 -m json.tool` (and `/egress`, `/items`, `/datasets`) | API is loopback-only on 4760. |

**Always run `pytest` before rebuilding** — the suite is fast and catches
regressions the live service would hide. After a registry edit, run a `collect`
cycle and check `/egress` + `/sources` to confirm the new/changed source fetched
through the VPN (real exit IP, `status: ok`), not `skipped`/`error`.

`--env-file ../../.env` is **required** (the shared fleet `.env` carries the PIA
creds the vpn-proxy needs, plus the optional FRED/NASS/EIA/GNews keys).

## The data model (registry-driven)

**Everything is driven by two YAML files.** No code change is needed to add a
feed, retag a source, or onboard a subscriber — edit the registry and rebuild.

### `registry/sources.yaml` — one entry per **distinct URL**
```yaml
  - id: al-jazeera              # unique, stable id
    type: rss                   # rss | (dataset entries use type with dataset_key/fetcher)
    url: "https://…/rss.xml"
    tags: [news, world, iran]   # MULTI-TAG: a source shared by 2 sites gets all their tags, ONE entry
    policy: vpn                 # vpn (default, fail-closed) | direct (allowlist — use sparingly)
    exit: any                   # any | us | eu  (which PIA region; us for US-gov/wire feeds)
    fetch:
      source_name: "Al Jazeera" # human label shown on items/egress
```
- A source used by multiple sites is listed **once** with the **union** of tags
  (e.g. `breaking-defense` serves americastrikes + aliencouncil). Never duplicate.
- Dataset sources reference a `dataset_key` + `fetcher` (see Datasets below).

### `registry/subscriptions.yaml` — one entry per **subscriber site**
```yaml
  americastrikes.com:
    items:
      tags_any: [defense, iran, diplomacy, markets, domestic, world]  # OR-match
      # tags_all: [...]    # AND-match (optional)
      limit: 200
      window_hours: 48
    datasets: [ephemeris, quakes]   # optional: dataset keys this site pulls
```
The site's puller calls `GET /subscriptions/<host>/items`; the hub resolves the
query and returns the matching, deduped, windowed items. The dashboard's
**source×site matrix** is exactly `sources.tags` × `subscriptions` computed from
these two files.

## VPN model + fail-closed (load-bearing — do not weaken)

The hub fetches through `tools/vpn-proxy` (dual PIA gluetun: US + EU, killswitch,
DNS-over-TLS, autoheal). collector + api run **on the `vpn-proxy_default`
external docker network**, so they reach the proxies by container name:
`http://vpn-us:8888` / `http://vpn-eu:8888` (control `http://vpn-us:8000`) — set
in compose via `DATAHUB_PROXY_US`/`…_EU`/`DATAHUB_CONTROL_*`.

- **`vpn.plan_fetch()` is fail-closed.** Before fetching a `policy: vpn` source it
  calls `probe_exit_ip()` through the proxy. If the exit IP can't be determined,
  **or it matches a home IP** (`DEFAULT_HOME_IPS = 24.55.143.75, 158.173.25.169`),
  the source is **skipped** (never fetched off-VPN). Only `policy: direct` sources
  bypass the proxy — keep that allowlist tiny and justified.
- **The exit-IP probe MUST use HTTPS** (`https://checkip.amazonaws.com`). Plain
  HTTP leaks gluetun's injected `X-Forwarded-For` (the 172.30.x container IP) and
  the probe falsely "succeeds". The HTTPS CONNECT tunnel is opaque to the proxy.
  This was a Critical bug — do not switch the probe to HTTP.
- Every fetch writes an **egress_log** row (source → target host, policy, exit
  node + real IP, status, note, when). That's what the dashboard ledger and
  `GET /egress` surface. Keep recording egress for every new fetch path.
- If you ever run the hub from a **different host**, add that host's outbound IP
  to `DATAHUB_HOME_IPS` (comma-separated env) so the leak check stays correct.

## Datasets (structured, non-RSS)

`src/datahub/datasets/` holds one module per dataset. `__init__.py` has a
`FETCHERS` registry mapping a **dataset key** → a `fetch(params, settings)`
callable returning records.

- **Keyless (live now):** `ephemeris` (local PyEphem — moon/zodiac/planets),
  `quakes` (USGS), `weather-alerts` (NOAA), `kindex` + `solar-xrays` (NOAA SWPC),
  `launches` (Launch Library), `tides` (NOAA CO-OPS).
- **Keyed (auto-skip until keys exist):** `fred` (FRED_API_KEY), `eia`
  (EIA_API_KEY), `nass` (NASS_API_KEY), GNews (GNEWS_API_KEY). With no key the
  fetcher raises `DatasetUnavailable("no-api-key")` **before any network call**,
  and the collector records `skipped-no-api-key` (not an error). **Adding a key
  to `/home/jesse/projects/domains/.env` needs ZERO code change** — the next
  cycle picks it up. (FRED/NASS/EIA/GNews keys are currently MISSING; the
  saveusfarms War Room + economy datasets stay empty until supplied.)
- **Secret redaction is mandatory.** `datasets/__init__._get_json` runs `_redact()`
  over HTTP-error strings before they reach `sources_state.last_error` / the
  egress note (both are served over the API). Any new keyed fetcher MUST route
  its HTTP calls through `_get_json` (or redact equivalently) so an API key can
  never leak into stored/served error text.

### Adding a dataset fetcher
1. Create `datasets/<name>.py` with `def fetch(params, settings) -> list[dict]:`
   (raise `DatasetUnavailable("no-api-key")` early if it needs an absent key;
   use `_get_json` for HTTP).
2. Register it in `datasets/__init__.py` `FETCHERS` under its key.
3. Add a source entry in `registry/sources.yaml` (`dataset_key`/`fetcher`, tags,
   `policy`, `exit`).
4. Add tests in `tests/test_datasets_*.py` (mock the HTTP; assert the record shape
   AND, for keyed, the redaction + graceful no-key skip).
5. `pytest -q` → rebuild → `collect` → confirm `/datasets/<key>` + `/egress`.

## How the fleet consumes the hub

- **Per-site pullers** — `sites/<host>/ops/scripts/pull-feeds.py` (americastrikes,
  aliencouncil, broadwayshowgirls, saveusfarms) each derived from that site's own
  former `scrape-feeds.py`: ONLY the fetch loop was swapped to
  `GET datahub-api:4760/subscriptions/<host>/items` (stdlib `urllib`); all cache
  logic (cap, seen-urls, cold-archive, `classify_beat`, atomic write) is preserved
  so `ops/cache/news-feed.json` stays byte-compatible. **Fail-safe:** hub-down or
  0-items → keep the existing cache, exit 0, and **never** fetch external feeds
  (no VPN bypass). They `os.chmod(0o664)` after the atomic write, and archive
  expired stories to cold **only after** the fail-safe guards. The old
  `scrape-feeds.py` is kept on disk for rollback.
- **sinderella** — `ops/llm/roles/brief_builder.py`: 6 keyless signal functions
  pull `/datasets/*` with their original implementation kept as fallback; local
  LLM synthesis untouched; FRED/GNews/tides/solar-wind unchanged.
- **Fleet Dashboard** — `tools/fleet-dashboard/server/datahub.js` reaches the hub
  by JOINING `vpn-proxy_default` and calling `datahub-api:4760` **by name**.

### Networking gotcha (every consumer hits this)
`datahub-api` publishes on **`127.0.0.1:4760` (host loopback only)**, so a
container CANNOT reach it via `host.docker.internal`. Any containerized consumer
must **join the external `vpn-proxy_default` network** and call
`http://datahub-api:4760` by name (set `DATAHUB_API` env).

### Two consumer dispatch architectures — VALIDATE THE RIGHT CONTAINER
Sites run the puller in one of two ways; check which before concluding a site is
broken (probing the wrong container gives a false "can't reach hub"):
- **In-container cron** (americastrikes, aliencouncil, saveusfarms): the
  persistent `<site>-cron` container runs `pull-feeds.py` directly and IS joined
  to `vpn-proxy_default`. Probe: `docker exec <site>-cron python3 -c "...datahub-api:4760..."`.
- **Ephemeral worker via `docker compose run`** (broadwayshowgirls, sinderella):
  the `<site>-cron` container is only a DISPATCHER (intentionally NOT on
  `vpn-proxy_default`); it runs `run-worker.sh <role>` which does
  `docker compose run --rm worker …`, spinning a throwaway **worker** container.
  The **`worker` service** (not cron) carries `vpn_proxy` + `DATAHUB_API`. Probing
  `<site>-cron` will (correctly) fail name resolution — that's NOT a fault. Probe
  the real path instead:
  `cd sites/<host> && docker compose --env-file ../../.env run --rm --no-deps --entrypoint sh worker -c "python3 -c \"import urllib.request; urllib.request.urlopen('http://datahub-api:4760/health',timeout=8)\""`
  If the ephemeral worker reaches the hub, the site is healthy.

### Onboarding a NEW site to pull from the hub (the Plan 4 pattern)
1. Add the site to `registry/subscriptions.yaml` (its `tags_any`, limit, window),
   add any new feeds to `sources.yaml` (reuse existing entries by adding tags if a
   source already exists), `pytest` → rebuild → `collect` → confirm
   `/subscriptions/<host>/items` returns items.
2. In the site submodule, create `ops/scripts/pull-feeds.py` derived from that
   site's `scrape-feeds.py` — swap ONLY the fetch loop for the hub pull, preserve
   all cache logic, keep the fail-safe (keep-cache-on-hub-down, never scrape
   externally), `os.chmod(0o664)` after writes, archive-after-guards.
3. Point the cron entrypoint (`run-scraper.sh` / `run-worker.sh scrape`) at
   `pull-feeds.py`; leave `scrape-feeds.py` for rollback.
4. Join the site's cron/worker container to `vpn-proxy_default` + set
   `DATAHUB_API=http://datahub-api:4760` in its compose.
5. Validate LIVE: run one cycle, confirm the schema is unchanged, the puller hits
   ONLY the hub, the egress ledger shows the VPN path (real exit IP, no home IP),
   and the fail-safe holds (stop `datahub-api`, run again → cache untouched, exit 0).
6. Commit in the submodule (per-file, never `-A`), bump the parent pointer.

## Load-bearing invariants / hard-won gotchas (don't regress these)

- **Fail-closed VPN.** Never let a `policy: vpn` source fetch when the exit IP is
  unprobable or a home IP. Never add a `direct` source without a real reason.
- **HTTPS exit-IP probe** (not HTTP — XFF leak). See VPN section.
- **Secret redaction** in `_get_json` — keyed fetchers must not leak keys into
  stored/served error strings.
- **api binds loopback; consumers join `vpn-proxy_default` + call by name.**
- **Multi-tag, store-once.** One source row per URL; shared sources get the union
  of tags. Dedup by URL in the store.
- **Graceful no-key skip** — keyed datasets raise `DatasetUnavailable` *before*
  the network and record `skipped-no-api-key`, never an error.
- **Puller fail-safe** — hub-down/0-items keeps the cache, exits 0, never scrapes
  externally; cold-archive ONLY after the guards; `chmod 0664` after atomic write.
- **Old cache files** from pre-migration root scraper runs may be mode-600
  root-owned; a uid-1000 cron then can't overwrite — one-time `chmod`/`chown`.
- **`--env-file ../../.env`** on every compose command (PIA creds + dataset keys).

## Verify before committing

```bash
cd tools/data-hub
.venv/bin/python -m pytest -q                                   # 54 tests, no Docker
docker compose --env-file ../../.env up -d --build              # ship src/registry changes
docker compose --env-file ../../.env exec -T collector python -m datahub collect   # fresh cycle
curl -s http://127.0.0.1:4760/health | python3 -m json.tool     # VPN exit IPs (no home IP)
curl -s "http://127.0.0.1:4760/egress?limit=20"                 # per-fetch ledger: status ok, real IP
curl -s "http://127.0.0.1:4760/sources" | python3 -m json.tool  # any new/changed source healthy?
```
For changes that touch a consumer (dashboard tab or a per-site puller), also
re-verify that consumer end-to-end (the dashboard's Data Hub tab renders; the
puller still writes a byte-compatible `news-feed.json` and holds the fail-safe).

## Commit convention

- Stage **only** the hub: `git add tools/data-hub/...` (per-file; the repo has many
  other in-flight changes — never `git add -A`).
- A repo hook (`deny-catastrophic.sh`) false-positives on some multi-line `-m`
  messages; if it bites, write the message to a file and `git commit -F <file>`.
  Avoid the literal `--force` token in messages.
- End the message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- This repo commits directly to `main`. Site-submodule changes (pullers) commit in
  the submodule first, then bump the parent pointer; push triggers CF Workers
  Builds for the site (harmless — ops/ changes don't alter the site build output).

## Quick reference

```
Location   /home/jesse/projects/domains/tools/data-hub        API: http://127.0.0.1:4760 (loopback)
Services   datahub-collector (supercronic, */30 collect)  ·  datahub-api (uvicorn)
Net        both on external `vpn-proxy_default`  ·  proxies: vpn-us:8888 / vpn-eu:8888
Store      SQLite WAL @ /data/data-hub.db (volume datahub-data)
CLI        python -m datahub collect | serve
Tests      .venv/bin/python -m pytest -q          (no Docker, in-memory SQLite)
Ship       docker compose --env-file ../../.env up -d --build     (src/ + registry/ baked in)
Fresh data docker compose --env-file ../../.env exec -T collector python -m datahub collect
Routes     /items  /subscriptions/<site>[/items]  /datasets[/<key>]  /egress  /sources  /health
Registry   registry/sources.yaml (per-URL, multi-tag)  ·  registry/subscriptions.yaml (per-site)
Datasets   datasets/<name>.py + FETCHERS registry  ·  keyed need FRED/NASS/EIA/GNEWS keys in .env
Consumers  sites/<host>/ops/scripts/pull-feeds.py  ·  sinderella brief_builder.py  ·  fleet-dashboard datahub.js
Home IPs   24.55.143.75, 158.173.25.169 (never a valid VPN exit)
Docs       tools/data-hub/README.md (canonical commands)  ·  memory: project_data_hub
Plans      docs/superpowers/{specs,plans}/2026-06-28-data-hub-*
```
