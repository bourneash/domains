# Design — `tools/site-tracker`

**Status:** approved framework, ready for implementation planning
**Date:** 2026-05-19
**Owner:** Jesse

## Problem

The portfolio has grown to 7 active sites and ~30 parked domains. There is no single place to see, per site, whether the maintenance work that has to happen has actually happened:

- Is the site verified in Google Search Console? Bing Webmaster?
- Has its sitemap been submitted?
- Does the live site actually have GA4 / AdSense / Meta Pixel installed?
- Is Cloudflare healthy (zone active, DNS records, worker bound, email routing)?
- Are the autonomous ops cron roles running?
- For things only Jesse knows (AdSense application status, Amazon Associates ID, niche category, notes), where do we record them?

Existing tooling covers traffic (`tools/cf-stats` → `tools/cf-grafana`) and ops heartbeats (`tools/status` reading each site's `ops/board/last-run.json`), but answers a different question: *how much traffic is this site getting* and *did the cron run*. It does not answer *is this site properly wired up*.

## Goals

1. One place to see the maintenance state of every site at a glance — a **status matrix**, not a time-series chart.
2. Each fact knows where it came from (scrape, API, file, human) and when it was verified, so freshness is always visible.
3. Manual facts (the ones no scraper can detect) get entered in the same UI you read them in — no editor context-switch.
4. Slots into existing patterns: Docker container on a port (like `cf-grafana`), reads `/home/jesse/projects/domains/.env`, output gitignored.

## Non-goals (v1)

- Public-facing dashboard at `dash.bourneash.com` (deferred indefinitely).
- Google Search Console / Bing Webmaster OAuth integration (v2 — too much setup tax for v1).
- Parked-site collection (v1 lists them in `sites.yml` but only collects facts for the 7 active sites).
- Replacing `cf-grafana` (it stays — different shape of data, different question).
- Replacing per-site `ops/board/last-run.json` (it stays — site-tracker reads it).

## Architecture

Five layers, each with one purpose:

```
┌─────────────────────────────────────────────────────────────┐
│ REGISTRY    sites.yml                                       │
│             per-site declarations + manual facts            │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────────────┐
│ COLLECTORS  collectors/*.py — one module per source type    │
│             filesystem │ http-scrape │ cf │ github │ (gsc)  │
└──────────────────────┬──────────────────────────────────────┘
                       │ writes (site, key, value, source, ts, state)
                       v
┌─────────────────────────────────────────────────────────────┐
│ STORE       facts.db (SQLite) + audit log                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────────────┐
│ API         FastAPI on localhost:4742, Jinja templates      │
│             reads facts, accepts edits, writes sites.yml    │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────────────┐
│ FRONTEND    HTMX fragments, status matrix, click to edit    │
└─────────────────────────────────────────────────────────────┘
```

All five layers run inside a single Docker container defined by `tools/site-tracker/docker-compose.yml`. Three processes inside the container:

1. **FastAPI server** — serves the UI and API on `:4742`.
2. **supercronic** — runs collectors on the schedule baked into the container's crontab.
3. **sites.yml watcher** — reloads when the file changes so the UI never serves a stale registry.

## Source taxonomy

This is the framework's core idea. Every fact reaches the store through one of five well-defined sources. The source is recorded on the row so freshness, trust, and "why does this say green?" are always answerable.

| Source bucket | Source values in DB | Setup cost | What it can answer | Examples |
|---|---|---|---|---|
| **filesystem / git** | `filesystem` | none — reads the repo | local repo health, ops heartbeats | last commit, dirty flag, `ops/board/last-run.json`, `ops/board/facts.json`, deploy flags, file presence |
| **http scrape** | `http_scrape` | none — anonymous GET | live-site hygiene, what's wired in | pixels in `<head>` (GA4, AdSense, Meta, GTM, Plausible), schema.org JSON-LD, canonical, OG tags, `sitemap.xml` 200, `robots.txt` parsed, TLS expiry, response ms |
| **api with creds** | `cf_api`, `github_api`, `gsc_api` (v2), `bing_api` (v2) | per-API OAuth/key | what only the upstream knows | Cloudflare zone state, GitHub repo state, GSC sitemap submitted + indexed pages, Bing same |
| **manual (sites.yml)** | `manual` | one-time per fact | things no scraper can know | AdSense application status, Amazon Associates ID, niche, registrar, notes |
| **site-pushed** | `site_push` | already happening | what the site uniquely knows about itself | `ops/board/last-run.json` heartbeats, future `ops/board/facts.json` from per-site cron |

**Fact ownership = hybrid.** Sites push the facts they uniquely know (heartbeats, "I deployed"). The central tool collects cross-cutting facts (CF, HTTP scrape, pixel detection, GitHub). User-supplied facts live in `sites.yml`. Each fact's source is recorded so you always know who wrote it.

## Components

### Registry — `sites.yml`

Single hand-edited file. One block per domain:

```yaml
aliencouncil.com:
  active: true
  cf_zone: aliencouncil.com
  github: bourneash/aliencouncil.com
  applies_to: [cf, gsc, bing, ga4, adsense, sitemap, ops, github]
  manual:
    adsense_status:
      value: approved
      set_at: 2026-04-12
    amazon_associates_id: bourneash-20
    notes: "primary disclosure-cycle brand"

deadlymaracas.com:
  active: false
  cf_zone: deadlymaracas.com
  applies_to: [cf, dns]    # parked — narrow row in the matrix
```

`applies_to` is the key idea. The matrix only renders cells the site declares it cares about. Parked sites get narrow rows; active sites get wide rows. No "this column doesn't apply" noise.

`sites.yml` is the source of truth — `DOMAINS_INDEX.md` is regenerated from it (a small `tools/site-tracker/scripts/render_domains_index.py`).

### Collectors

One Python module per source type, all in `tools/site-tracker/collectors/`. Each module is roughly 100 lines, exposes a `run(sites_yaml, db) -> None` entry point, and writes facts via a single helper `upsert_fact(site, key, value, source, state, ttl_hours)`.

| Module | Cadence (in-container crontab) |
|---|---|
| `collect_filesystem.py` | every 15 min |
| `collect_http.py` | hourly at `:17` |
| `collect_cloudflare.py` | hourly at `:23` (offset from the existing `cf-stats` collector) |
| `collect_github.py` | daily at `04:00 UTC` |
| `collect_search_consoles.py` | **deferred to v2** — stubbed module that exits 0 |

Each collector writes its own per-key facts. A collector failure logs to stderr (captured by `docker logs`) and marks any facts it would have updated as `state='unknown'`, leaving the previous value in the DB.

### Store — `data/facts.db` (SQLite)

```sql
CREATE TABLE facts (
  site         TEXT NOT NULL,
  key          TEXT NOT NULL,           -- e.g. 'http.ga4_present'
  value        TEXT,                    -- JSON-encoded scalar or object
  source       TEXT NOT NULL,           -- 'filesystem' | 'http_scrape' | 'cf_api'
                                        -- | 'github_api' | 'manual' | 'site_push'
  verified_at  TEXT NOT NULL,           -- ISO 8601 UTC
  state        TEXT NOT NULL,           -- 'green' | 'yellow' | 'red'
                                        -- | 'unknown' | 'n_a' | 'stale'
  ttl_hours    INTEGER,                 -- past this, state degrades to 'stale'
  PRIMARY KEY (site, key)
);

CREATE TABLE audit (
  ts          TEXT NOT NULL,            -- ISO 8601 UTC
  site        TEXT NOT NULL,
  key         TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  source      TEXT NOT NULL
);
CREATE INDEX audit_site_key ON audit(site, key, ts);
```

The audit table is append-only and gives a per-fact history. Pruned by a daily collector that drops entries older than 90 days.

### API surface

FastAPI app at `tools/site-tracker/app/main.py`. All HTML routes return Jinja-rendered fragments suitable for HTMX swaps.

```
GET  /                              → full page: status matrix
GET  /site/{site}                   → full page: drill-down (every fact + source + age)
GET  /site/{site}/edit/{key}        → fragment: inline edit form (HTMX target)
POST /site/{site}/edit/{key}        → writes sites.yml, commits, returns refreshed cell fragment
GET  /collectors                    → full page: last-run per collector
POST /collectors/{name}/run         → triggers a one-shot collector run (background)
GET  /healthz                       → liveness for `docker compose ps`
```

Edit POSTs perform a git commit in the parent domains repo with a message like:

```
site-tracker: aliencouncil.com adsense_status = approved
```

A configuration flag in `sites.yml` (`auto_commit: true` at the top level) controls whether the commit is auto-pushed. Default: commit locally but do not push.

### Frontend

Server-rendered HTML + HTMX. No build step, no npm. Templates in `tools/site-tracker/app/templates/`. CSS is a single stylesheet with CSS custom properties for the state colors. No client-side framework.

The matrix page:

```
                     │ CF │ GSC │ Bing │ GA4 │ AdSense │ Sitemap │ Ops │ Last Deploy │
aliencouncil.com     │ ✓  │  ✓  │  ✓   │ ✓   │   ✓     │   ✓     │  ✓  │   2h ago    │
americastrikes.com   │ ✓  │  ✓  │  —   │ ✓   │   ?     │   ✓     │  ✓  │  15m ago    │
xxxtea.com           │ ✓  │  ?  │  —   │ —   │   —     │   ✓     │  ✓  │   3d ago    │
...
```

Clicking a yellow `?` cell triggers `hx-get="/site/{site}/edit/{key}"` which swaps the cell with an inline `<input>` form. Submit triggers a `POST` to the same key; on success the response is the refreshed cell (now green), swapped back in place.

## Data flow

```
   in-container cron        sites.yml         /home/jesse/projects/domains/.env
        │                       │                          │
        v                       v                          v
   ┌──────────────────────────────────────────────────────────┐
   │       collectors run inside container (supercronic)       │
   │  each writes its slice of facts to SQLite + audit log    │
   └──────────────────────────┬───────────────────────────────┘
                              │
                              v
                  ┌───────────────────────┐
                  │   data/facts.db       │
                  └───────────┬───────────┘
                              │
                              v
                  ┌───────────────────────┐
                  │   FastAPI server      │  (localhost:4742)
                  └───────────┬───────────┘
                              │ Jinja-rendered HTML + HTMX swaps
                              v
                  ┌───────────────────────┐
                  │      browser          │
                  └───────────┬───────────┘
                              │ POST /edit
                              v
                  writes sites.yml + git commit
                  optionally triggers force-recollect
```

## Error handling (v1)

| Failure | Behavior |
|---|---|
| Collector throws | log to stderr, mark affected facts `state='unknown'`, leave previous value |
| HTTP scrape timeout | record `state='unknown'`, record the failure in audit |
| CF API rate limit | exponential backoff inside the collector, then `state='unknown'` |
| sites.yml malformed YAML | API refuses to start; container log shows the parse error; collectors skip the run |
| sites.yml schema mismatch | API starts, drill-down shows the validation error for affected sites; matrix renders other sites normally |
| Edit POST git commit fails | return HTTP 500 + HTML error fragment, no partial write |
| SQLite locked | retry 3× with 100ms backoff, then HTTP 503 |

## Testing (v1)

- **Unit tests per collector** with HTTP/CF/GitHub responses mocked via `responses` library. Each collector module ships with its test file in `tools/site-tracker/tests/test_collect_<source>.py`.
- **One end-to-end test** spins up the container with a fixture `sites.yml`, hits `GET /`, asserts the matrix renders with expected rows, then hits an edit endpoint and asserts `sites.yml` was mutated and the audit table grew by one row.
- No CI — tests run locally via `pytest`. Pre-commit hook is optional and out of scope.

## Container layout

```
tools/site-tracker/
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── crontab.docker                 # supercronic schedule
├── entrypoint.sh                  # starts FastAPI + supercronic
├── README.md
├── sites.yml                      # NOT gitignored — the registry IS source
├── app/
│   ├── main.py                    # FastAPI app
│   ├── store.py                   # SQLite helpers
│   ├── registry.py                # sites.yml load/save
│   ├── templates/
│   │   ├── base.html
│   │   ├── matrix.html
│   │   ├── site_detail.html
│   │   └── fragments/
│   │       ├── cell.html
│   │       └── edit_form.html
│   └── static/
│       └── style.css
├── collectors/
│   ├── __init__.py
│   ├── collect_filesystem.py
│   ├── collect_http.py
│   ├── collect_cloudflare.py
│   ├── collect_github.py
│   └── collect_search_consoles.py # stub for v2
├── scripts/
│   └── render_domains_index.py
├── tests/
│   ├── test_collect_filesystem.py
│   ├── test_collect_http.py
│   ├── test_collect_cloudflare.py
│   ├── test_collect_github.py
│   ├── test_api.py
│   └── fixtures/
│       └── sites.yml
├── data/                          # gitignored
│   └── facts.db
└── out/                           # gitignored — logs
    └── cron.log
```

## Conventions adopted from existing tools

- Python tool with own venv (`pip install -e .` into `.venv/`).
- Reads creds from `/home/jesse/projects/domains/.env`.
- Output (`data/`, `out/`) gitignored.
- Container pattern from `tools/cf-stats/` + `tools/cf-grafana/` (supercronic + bind mounts).
- Port chosen to be adjacent to `cf-grafana` (`:4741`) → `:4742`.

## Path conventions

The container bind-mounts the parent domains repo at `/work`:

- `sites.yml` lives at `/work/tools/site-tracker/sites.yml`.
- Per-site repos live at `/work/sites/<domain>/` (e.g. `/work/sites/aliencouncil.com/`).
- `collect_filesystem` reads `/work/sites/<domain>/ops/board/last-run.json` and `/work/sites/<domain>/ops/board/facts.json`.
- Edit POSTs that mutate `sites.yml` run `git commit` inside `/work` (the parent domains repo), not inside the per-site submodule.

## v1 scope vs deferred

| In v1 | Deferred |
|---|---|
| All 5 layers built | GSC + Bing OAuth |
| `collect_filesystem`, `collect_http`, `collect_cloudflare`, `collect_github` | Per-site `ops/board/facts.json` writers across all 7 sites |
| Status matrix + drill-down + cell edit flow | Active collection for parked sites |
| The 7 active sites listed in `DOMAINS_INDEX.md` | Hosted `dash.bourneash.com` (still deferred) |
| `sites.yml` registry + scripts to regenerate `DOMAINS_INDEX.md` | Time-series view (`cf-grafana` keeps that role, linked from drill-down) |
| `docker compose up -d` runs the whole thing | A `site-tracker ask` CLI helper (matrix edit covers v1) |

## What this does NOT replace

- **`cf-grafana`** — still the right tool for time-series traffic; linked from each site's drill-down page.
- **`tools/status` CLI** — still useful for a terminal one-shot. Optional v1 polish: re-point `tools/status` at `facts.db` so the CLI and the web app read one store.
- **Per-site `ops/board/last-run.json`** — site-tracker reads it; the writing path stays in each site's cron.

## Open questions for the implementation plan

These do not need to be answered in this design doc but should be settled when the plan is written:

1. **First fact keys to enumerate.** The schema is open; the v1 list of `(key, collector, state-rules)` tuples needs to be pinned. Suggested starting list: `cf.zone_active`, `cf.worker_bound`, `cf.email_routing`, `http.ga4_present`, `http.adsense_present`, `http.meta_pixel_present`, `http.gtm_present`, `http.sitemap_200`, `http.robots_present`, `http.tls_expiry_days`, `fs.last_commit_age_hours`, `fs.ops_board_last_run`, `github.commits_ahead`, `github.last_push`, plus the `manual.*` keys.
2. **State thresholds.** Per-fact greens/yellows/reds — global defaults in code, overridable per site in `sites.yml`?
3. **`auto_commit` default.** Commit + push, or commit only? (Designed as commit-only by default.)
4. **Test data fixtures.** A `tests/fixtures/sites.yml` with 2–3 toy sites + canned HTTP responses.

---

_End of design._
