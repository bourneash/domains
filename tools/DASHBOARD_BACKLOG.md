# Dashboard backlog

Remaining work from `DASHBOARD_DRAFT_PLAN.md` (2026-04-28). The plan
proposed a `tools/dashboard/` static HTML page giving Jesse a single
glanceable view of the entire portfolio. Since then, two of the four
layers in the plan have shipped:

- **CLI dashboard** — `tools/status` (traffic + ops health by site)
- **Visual dashboards** — `tools/cf-grafana/` (Grafana stack on the
  cf-stats SQLite; portfolio + zone-detail boards)

What's still missing is the **single-page visual portfolio view** (cards
with thumbnails) and a handful of cross-cutting conventions that would
feed it. This file is what's left.

---

## Visual dashboard (`tools/dashboard/`) — not started

A static `index.html` per the plan: card per active site with thumbnail,
status dot, fresh git/deploy/cron lines, links. No server, no auth,
read-only. See §5–7 of the original draft for the full design (kept in
git history at 4224eb9^).

- [ ] **Scaffold `tools/dashboard/`** with `sites.yml` + `collect.mjs` +
      `index.html`. Read `DOMAINS_INDEX.md` initially; promote to
      `sites.yml` as source-of-truth in a second pass.
- [ ] **Tier 1 collect** (filesystem + git): last commit time/subject/sha,
      dirty flag, task counts, creds-open count. One git invocation per
      site, walk the 7 active sites.
- [ ] **HTML render** — vanilla JS, fetch `domains.json`, CSS grid of
      cards sorted red → yellow → green. No build step.
- [ ] **Screenshot pass** (`screenshot.mjs`) — Playwright thumbnails at
      1280×800, webp q=70, sequential. Output to `tools/dashboard/thumbnails/`
      (gitignored).
- [ ] **Tier 2 HTTP checks** — status code, response ms, TLS expiry,
      per-site smoke-string match. ~7 requests per refresh.
- [ ] **Status rollup logic** (green/yellow/red) — implement the
      thresholds from §4 of the draft, but per-site overrideable via
      `sites.yml.freshness.{commit_warn_days,commit_red_days}`.
- [ ] **Cron the refresh** — daily `refresh.sh` so `domains.json` never
      goes stale; weekly screenshot regen.

## Cross-cutting conventions — partly shipped

- [x] **Per-site `ops/board/last-run.json`** — already exists for
      americastrikes, aliencouncil, reviewtattoo (likely others). Used
      by `tools/status --ops`. This is the heartbeat from §5 of the
      draft, just under a different filename. Standardize: every site
      that runs cron jobs should write this on every role exit.
- [ ] **Heartbeat-writing wrapper across sites** — sinderella and
      ultrarough still show "board empty" in `tools/status --ops`.
      Either their roles aren't writing the file, or the cron isn't
      firing. Audit each.
- [ ] **`.deploy-needed` flag convention** — only americastrikes uses
      this so far (flag-triggered deployer). The dashboard's "we have
      unshipped work" yellow signal depends on it being adopted by the
      other 6 sites or replaced with a different per-site signal.
- [ ] **Per-site smoke string** — `sites.yml.smoke_string` per the
      draft. Currently no site has one. Pick a stable canary string
      per site (e.g. tagline, brand name) and add it.
- [ ] **`sites.yml` registry** — machine-readable replacement for the
      manually-maintained `DOMAINS_INDEX.md`. Generate `DOMAINS_INDEX.md`
      from it so the two never drift.

## Tier 3 (CF analytics) — shipped differently

The draft called for a `--cf` collector pass writing zone analytics into
`domains.json`. Instead this lives in `tools/cf-stats/` (hourly JSONL
snapshots) and renders via Grafana at `tools/cf-grafana/`. When the
visual dashboard ships, it should pull the same `latest.json` rather
than make its own CF calls.

## Explicitly deferred (out of v1, may never)

- GSC impressions/clicks (OAuth setup)
- Plausible / GA4 sessions
- Amazon Associates earnings (no API)
- Public-facing dashboard at `dash.bourneash.com` behind Access

---

_Created 2026-05-17 from `DASHBOARD_DRAFT_PLAN.md` (now deleted)._
