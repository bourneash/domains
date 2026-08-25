# tools/

Local utilities shared across all domain projects under `/home/jesse/projects/domains/`. Each tool is self-contained — its own venv, its own deps, its own CLI.

## Tools

| Tool | What it does |
|------|--------------|
| [`affiliate-audit/`](./affiliate-audit/) | Fleet service that discovers, resolves, classifies, and checks affiliate links (Amazon `/go/` cloaks etc.) across every site. |
| [`ai-inventory/`](./ai-inventory/) | `audit-ai.py` — one-row-per-service table of fleet AI usage (local/remote, model, enabled/disabled) for the `domains-audit-ai-inventory` skill. |
| [`amz-stats/`](./amz-stats/) | Daily Amazon affiliate catalog snapshot — scans every site's `affiliate.ts` for ASINs, checks availability/pricing via the Amazon Creators API, writes JSONL + `latest.json`. |
| [`cf-grafana/`](./cf-grafana/) | Grafana stack on the cf-stats SQLite — auto-ingests cf-stats JSONL, serves portfolio + zone-detail dashboards at `localhost:4741`. Bring up with `docker compose up -d`. |
| [`cf-stats/`](./cf-stats/) | Hourly **Cloudflare** account/usage snapshot — token health + expiry, zones, DNS, workers, custom domains, email routing, 24h request/error totals. JSONL per day + `latest.json`. Runs as a supercronic container; no host cron. |
| [`creator-connections/`](./creator-connections/) | Shared Amazon Creator Connections lib (`cc_lib.py`) — `pull`/`submit`/`submit_all` campaign flow, dashboard-only, used across 6 sites. |
| [`cron-bouncer/`](./cron-bouncer/) | `bounce-crons.sh` — restarts stuck/hung fleet cron containers. |
| [`cron-roles/`](./cron-roles/) | Reusable cron-role library + installer skills (engineer, affiliate-editor, content-writer, planner, seo-analyst, maintainer, watchdog, social-poster) — stamp-once, dynamic handoff. |
| [`data-hub/`](./data-hub/) | Central VPN-routed RSS aggregation service for the fleet — tagged sources, HTTP API, replaces per-site scrapers. |
| [`data-hub-images/`](./data-hub-images/) | Companion image-asset service to `data-hub/` — containerized API + client + monitor. |
| [`deployment-tester/`](./deployment-tester/) | Probes every site repo's Cloudflare Workers Builds push-to-deploy pipeline (`.deploy-probe` bump → push → `--verify` worker version) to catch broken deploys. |
| [`domain-developer/`](./domain-developer/) | Per-site sandboxed Claude dev containers (CLI + web panel) — only that site's dir bind-mounted, host filesystem protected under `--dangerously-skip-permissions`. |
| [`engineer-fleet/`](./engineer-fleet/) | Dynamic, read-only, zero-token audit of the Engineer cron role across every site (`engineer-status.py`). |
| [`env-broker/`](./env-broker/) | Renders each site container a **minimal** `.env` (~4 keys) from Vaultwarden instead of the 60-key shared fleet file. Allowlist in `policy.yaml`, drift check re-derives real usage from each site's `ops/`. Containers never talk to the vault. |
| [`fleet-dashboard/`](./fleet-dashboard/) | Portfolio control-plane web app at `localhost:4754` — Domain Control matrix, agent pages, containers, git, tasks, cron. |
| [`fleet-gatus/`](./fleet-gatus/) | Gatus-based health-check + alerting layer for every domain in the portfolio — dashboard, threshold-based Slack alerts, surfaced natively in `fleet-dashboard`'s Health tab. |
| [`fleet-test/`](./fleet-test/) | Runs every first-party tool test suite under `tools/` in one pass (~2 min, zero-AI, offline). Roster in `suites.yaml` + a drift check so a new tool can't silently escape the sweep. Scheduled daily; healthy = silent. |
| [`ga4-provision/`](./ga4-provision/) | One-time interactive provisioner — grants the fleet service account Viewer on every GA4 property; includes `oauth.py`. |
| [`gh-stats/`](./gh-stats/) | Hourly per-repo GitHub snapshot collector for the Developer Grafana dashboard. |
| [`git-hooks/`](./git-hooks/) | Shared `pre-commit` hook installed across site repos. |
| [`google-auth/`](./google-auth/) | Shared Google OAuth helper library used by GA4/GSC tooling. |
| [`gsc-verify/`](./gsc-verify/) | Verifies fleet domains in Google Search Console by writing a DNS TXT record via Cloudflare, self-service (GSC API can't grant access directly). |
| [`lama-cleaner/`](./lama-cleaner/) | Launches **IOPaint** (the maintained lama-cleaner) GPU-accelerated on a directory of images. Random free port, prints local + LAN URL. |
| [`media-gen/`](./media-gen/) | On-demand AI image **generation** for the fleet, `data-hub-images`' sibling — local ComfyUI (fast, default) or CloakBrowser+Nano Banana (real browser, opt-in). HTTP API at `localhost:4780`, host process (not dockerized — both backends need host-local access). |
| [`personas/`](./personas/) | Persona definitions backing site voice/brand for content and social tooling (`domains-persona-create` skill). |
| [`post-notify/`](./post-notify/) | Shared "new post" Slack announcer — one Block Kit card format, config-driven per site. |
| [`role-notify/`](./role-notify/) | Shared "role completed" Slack notifier — emoji + checkmark + real files/status, replaces flat ad-hoc messages. |
| [`scripts/`](./scripts/) | Standalone ops scripts: domain bootstrap/bind-worker, submodule bump, index/worker-name drift checks, fleet-cron/secscan/worker-reaper cron jobs. |
| [`seo-history/`](./seo-history/) | `seo_history.py` — historical SEO metric tracking for the `domains-seo-history` skill. |
| [`site-tracker/`](./site-tracker/) | Portfolio maintenance dashboard at `localhost:4742` — per-site verification/wiring state in a status matrix (CF, GA4, AdSense, sitemap, TLS, git, GitHub, manual facts). Containerized FastAPI + HTMX + SQLite. Click any cell to edit manual facts; writes back to `sites.yml` and commits. |
| [`social-lib/`](./social-lib/) | Shared social media automation library — platform clients + posting primitives used by `social-poster` and `social-setup`. |
| [`social-poster/`](./social-poster/) | Cron role that posts scheduled content to each site's connected social accounts via `social-lib`. |
| [`social-setup/`](./social-setup/) | CloakBrowser-powered social media account provisioner — 7 platforms, guided semi-auto, writes creds to `ops/social/`. |
| [`status`](./status) | One-shot CLI dashboard — per-site 24h requests, 7d pageviews/uniques/threats/cache, plus per-role ops health from each site's `ops/board/last-run.json`. |
| [`task-budget/`](./task-budget/) | Reusable turn-budget derivation for writer-type cron roles across the fleet. |
| [`vpn-proxy/`](./vpn-proxy/) | Dual-location PIA VPN HTTP proxy for fleet scrapers — two gluetun containers (US/EU exit), each exposing a local HTTP proxy. |

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
