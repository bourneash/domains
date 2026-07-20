# site-tracker

Portfolio maintenance dashboard — per-site verification/wiring state across
the domains portfolio. Status matrix view at `localhost:4742`, click-to-edit
manual facts, collectors run on cron inside the container.

Design: [`docs/superpowers/specs/2026-05-19-site-tracker-design.md`](../../docs/superpowers/specs/2026-05-19-site-tracker-design.md)

## Quickstart

```bash
cd tools/site-tracker
docker compose up -d --build
open http://localhost:4742
```

## What you see

- **Matrix (`/`)** — one row per site, one column per fact family. Each cell is a rollup of all facts in that family. Green/yellow/red/stale/unknown/n_a.
- **Drill-down (`/site/<site>`)** — every individual fact with value, source, age, state. Manual facts at the bottom; click any value to edit inline.
- **Collectors (`/collectors`)** — list and force-run each collector.

## Fact sources

| Source       | What it produces                                                  | Cadence |
|--------------|-------------------------------------------------------------------|---------|
| filesystem   | last commit age, ops/board last-run age                           | 15 min  |
| http_scrape  | GA4/AdSense/Meta Pixel/GTM in `<head>`, sitemap.xml, robots.txt, TLS expiry | hourly :17 |
| cloudflare   | zone active, worker bound, email routing                          | hourly :33 |
| github       | last push age                                                     | daily 04:00 |
| manual       | anything you type into a cell (writes sites.yml, commits)         | on edit |
| site_push    | (reserved) per-site cron writes ops/board/facts.json              | n/a v1  |

## Files

| File | Purpose |
|------|---------|
| `sites.yml` | Site registry — source of truth. Hand-edited; `manual:` block is written by the edit-cell POST. |
| `src/site_tracker/fact_keys.py` | The v1 fact registry (key → family, source, TTL, state rule). |
| `src/site_tracker/collectors/` | One module per source type. |
| `src/site_tracker/app/main.py` | FastAPI app. |
| `data/facts.db` | SQLite store (gitignored). |
| `out/cron.log` | supercronic output (gitignored). |

## Operations

```bash
# Bring up
docker compose up -d --build

# Watch
docker compose logs -f

# Force one collector
docker compose exec site-tracker site-tracker collect cloudflare

# Force all
docker compose exec site-tracker site-tracker collect-all

# Regenerate DOMAINS_INDEX.md from sites.yml
docker compose exec site-tracker site-tracker render-domains-index --out /work/DOMAINS_INDEX.md

# Take down
docker compose down
```

## What it does NOT do (v1)

- Active collection for parked sites — they're in `sites.yml` but collectors skip them.
- Time-series view — use `cf-grafana` for that.
- Hosted on the public internet — local-only by design.
