# tools/

Local utilities shared across all domain projects under `/home/jesse/projects/domains/`. Each tool is self-contained — its own venv, its own deps, its own CLI.

## Tools

| Tool | What it does |
|------|--------------|
| [`cf-stats/`](./cf-stats/) | Hourly **Cloudflare** account/usage snapshot — token health + expiry, zones, DNS, workers, custom domains, email routing, 24h request/error totals. JSONL per day + `latest.json`. Runs as a supercronic container (see its `docker-compose.yml`); no host cron. |
| [`cf-grafana/`](./cf-grafana/) | Grafana stack on the cf-stats SQLite — auto-ingests the JSONL files cf-stats produces, serves portfolio + zone-detail dashboards at `localhost:4741`. Bring up with `docker compose up -d`. |
| [`lama-cleaner/`](./lama-cleaner/) | Launches **IOPaint** (the maintained lama-cleaner) GPU-accelerated on a directory of images. Random free port, prints local + LAN URL. |
| [`status`](./status) | One-shot CLI dashboard — per-site 24h requests, 7d pageviews/uniques/threats/cache, plus per-role ops health from each site's `ops/board/last-run.json`. |

## Conventions

- Each tool lives in its own subdirectory.
- Python tools install via `pip install -e .` into a local `.venv/`.
- Anything that needs credentials reads them from `/home/jesse/projects/domains/.env` (the shared envfile that already holds Cloudflare + affiliate creds).
- Output goes to `<tool>/out/` (gitignored).

## Adding a new tool

1. Create `tools/<name>/` with a `pyproject.toml` (or equivalent), source, and `README.md`.
2. Add a `.gitignore` with at minimum `.venv/`, `__pycache__/`, `out/`.
3. If it needs creds, append slots to `/home/jesse/projects/domains/.env` and document them in the tool's README.
4. Add a row to the table above.
