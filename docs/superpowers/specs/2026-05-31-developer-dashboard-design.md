# Developer Dashboard — design

**Date:** 2026-05-31
**Status:** approved (design), pending spec review
**Author:** Claude (operator) for Jesse

## Problem

Jesse needs a glanceable "Developer" view in Grafana that answers, per site:

1. **Did something deploy, and when?** — a last-deployment log.
2. **What's the GitHub state?** — branches each repo carries, last commit to
   `main`, open PRs, recent merges.
3. **Did my push actually ship?** — correlate "latest commit on `main`"
   (GitHub) against "latest deploy" (Cloudflare) and flag drift.
4. **What other CF build data is useful?** — surface deploy source
   (`wrangler` vs CI) so a misconfigured push-to-deploy pipeline is visible
   continuously, not just when `deployment-tester` is run by hand.

## Constraints & findings (verified 2026-05-31)

- **GitHub is low-effort to add.** `GITHUB_TOKEN` is in the shared `.env`
  with full `repo` scope. The REST API already returns everything needed:
  default branch, branch list, last commit to `main`, open PRs, merged PRs.
- **Repo slugs drop the TLD inconsistently.** `bourneash/aliencouncil` but
  `bourneash/ultrarough.com` and `bourneash/xxxtea.com`. The mapping already
  exists in `tools/site-tracker/sites.yml` (`sites.<domain>.github`). We
  read that file; we do **not** re-derive or hardcode slugs.
- **CF deploy log is already one API call away.**
  `GET /accounts/{acct}/workers/scripts/{name}/deployments` returns, per
  deploy: `created_on`, `source` (`wrangler` vs CI), `author_email`,
  `versions[].version_id`, `annotations.workers/triggered_by`. cf-stats does
  not capture this yet (it only stores each worker's `modified_on`).
- **Worker-name drift is already solved by data we collect.** The existing
  `collect_worker_domains()` returns `zone_name → service` (the worker name
  bound to each domain). So `domain → worker` resolves from live CF data —
  no need to add a `cf_worker` field to the registry.
- **Limitation to accept:** the dedicated Cloudflare *Workers Builds* CI API
  (build pass/fail, build duration, build logs) returns `No route for that
  URI` / `Not found` with our token — that telemetry is **not** available to
  us. The deployments API is the substitute. Its `source` field is the best
  proxy we have for "shipped via CI vs shipped via wrangler."

## Architecture

Reuses the proven cf-stats → cf-grafana pattern exactly. No new runtime
stack; Grafana stays at `:4741` on the existing SQLite datasource.

```
                       reads sites.yml (domain → github slug)
                                  │
 ┌─────────────┐   JSONL   ┌──────────────┐   ┌─────────────────┐
 │  gh-stats   │──────────▶│  out/*.jsonl │   │  cf-stats       │
 │ (NEW tool)  │           │  latest.json │   │ (+deployments)  │
 └─────────────┘           └──────────────┘   └────────┬────────┘
       GitHub REST                                      │ JSONL
                                                        ▼
                              ┌──────────────────────────────────┐
                              │  cf-grafana/ingest.py (extended)  │
                              │  → SQLite tables                  │
                              └──────────────┬───────────────────┘
                                             ▼
                              ┌──────────────────────────────────┐
                              │  Grafana :4741                    │
                              │  developer.json (NEW dashboard)   │
                              └──────────────────────────────────┘
```

Four work items:

### 1. cf-stats — add `collect_deployments()`

New collector in `tools/cf-stats/src/cf_stats/collectors.py`, wired into
`cli.py`'s snapshot under a new `deployments` key. For each worker script
(from the existing `collect_workers` list), fetch the latest ~5 deployments:

```json
"deployments": {
  "ok": true,
  "per_worker": {
    "aliencouncil": [
      {"created_on": "...", "source": "wrangler",
       "version_id": "a365...", "triggered_by": "deployment",
       "author": "jessetamburino@hotmail.com"}
    ]
  },
  "errors": {}
}
```

Best-effort per the existing collector contract: one worker erroring records
its error string and never kills the snapshot. ~42 workers × 1 GET; runs in
the existing hourly cron.

### 2. New tool `tools/gh-stats/`

Mirrors cf-stats' shape so it's instantly familiar:

```
gh-stats/
  src/gh_stats/
    api.py          # thin GitHub REST client (httpx, retries, pagination)
    collectors.py   # per-repo collectors, all best-effort
    cli.py          # snapshot → out/gh-stats-YYYY-MM-DD.jsonl + latest.json
  out/              # gitignored snapshots
  Dockerfile
  docker-compose.yml
  entrypoint.sh     # hourly cron, same as cf-stats
  crontab.docker
  pyproject.toml
  README.md
```

**Registry source:** reads `../site-tracker/sites.yml` (path overridable by
env). Only `active: true` sites with a `github:` slug are collected. This is
the single source of truth; gh-stats never hardcodes the domain↔repo map.

**Env:** `GITHUB_TOKEN` (or `GH_TOKEN`) from the shared `.env`.

Per-repo collectors produce a snapshot keyed by domain:

```json
"repos": {
  "aliencouncil.com": {
    "ok": true,
    "slug": "bourneash/aliencouncil",
    "default_branch": "main",
    "visibility": "private",
    "branches": ["main", "chore/astro6-...", "cloudflare/..."],
    "branch_count": 3,
    "last_main_commit": {"sha": "b56fe5b", "date": "...", "message": "..."},
    "open_prs": [{"number": 2, "title": "...", "head": "chore/..."}],
    "open_pr_count": 2,
    "last_merged_pr": {"number": 1, "title": "...", "merged_at": "..."}
  }
}
```

### 3. cf-grafana — extend `ingest.py`

Add ingest of the two new data shapes into new SQLite tables:

```sql
CREATE TABLE deployments (        -- from cf-stats
  ts TEXT, worker TEXT, created_on TEXT, source TEXT,
  version_id TEXT, triggered_by TEXT, author TEXT,
  PRIMARY KEY (worker, created_on)
);
CREATE TABLE gh_repos (           -- from gh-stats latest.json, per refresh
  ts TEXT, site TEXT, slug TEXT, default_branch TEXT,
  branch_count INTEGER, branches TEXT,           -- JSON array
  last_commit_sha TEXT, last_commit_date TEXT, last_commit_msg TEXT,
  open_pr_count INTEGER, open_prs TEXT,          -- JSON array
  PRIMARY KEY (ts, site)
);
CREATE TABLE gh_prs (             -- one row per open PR, for the PR table panel
  ts TEXT, site TEXT, number INTEGER, title TEXT, head TEXT,
  PRIMARY KEY (ts, site, number)
);
```

ingest reads gh-stats `out/` via a new read-only bind mount in
`cf-grafana/docker-compose.yml` (mirrors the existing `../cf-stats/out`
mount). Domain→worker join for the drift panel uses the `worker_domains`
data already in cf-stats `latest.json` (ingested into a small
`zone_worker(zone, worker)` lookup table).

### 4. cf-grafana — new `developer.json` dashboard

Panels (top to bottom):

1. **Pipeline status** (table, headline) — one row per active site:
   `site · last main commit (sha+age) · last deploy (age) · deploy source ·
   DRIFT`. DRIFT cell turns **red** when `last_main_commit.date >
   last_deploy.created_on` (main is ahead of what shipped), **green**
   otherwise, **grey** when either side is unknown. Value-mapping +
   cell-coloring via Grafana table thresholds.
2. **Deploy log** (table) — recent deploys newest-first:
   `time · site · source (CI/wrangler) · version_id · author`. This is the
   "last deployment log" Jesse asked for. Source rendered as a colored tag
   (wrangler = blue, CI = green) so a pipeline that silently fell back to
   wrangler is obvious.
3. **Branches** (table) — `site · branch_count · branches`. Highlights repos
   carrying unmerged feature branches (e.g. aliencouncil's two open chores).
4. **Open PRs** (table) — `site · # · title · head branch`.
5. **Stat tiles** (row of stats) — sites in drift · total open PRs · deploys
   in last 24h · deploys in last 7d.

All panels use the existing `frser-sqlite-datasource`. No auth changes;
dashboard is provisioned via the existing file provider, so it appears
automatically on container reload.

## Data flow

1. Hourly: cf-stats cron writes a snapshot incl. new `deployments`; gh-stats
   cron writes its snapshot incl. `repos`.
2. Every 5 min: cf-grafana `ingest` loop upserts both `latest.json`s + the
   day's JSONL into SQLite (deployments dedup on `(worker, created_on)`;
   gh tables keyed by `ts` so history accrues for trend panels).
3. Grafana queries SQLite live; the drift join is computed in the panel SQL.

## Error handling

- Every collector follows cf-stats' established `{"ok": bool, ...}` contract;
  a single failing repo or worker degrades to an error string, never aborts
  the snapshot.
- Missing `GITHUB_TOKEN` → gh-stats writes a snapshot with `repos: {}` and a
  top-level note, so the dashboard shows "unknown" cells rather than breaking.
- ingest is idempotent (upserts); a partial/corrupt JSONL line is skipped
  with a logged warning, matching current ingest behavior.

## Testing

- **gh-stats:** unit-test collectors against recorded GitHub JSON fixtures
  (mirror site-tracker's `tests/test_collect_github.py` style) — assert the
  TLD-drift slugs resolve and best-effort degradation works. One live
  smoke: `gh-stats snapshot --print` against the real account.
- **cf-stats:** unit-test `collect_deployments()` parsing against a recorded
  deployments payload (we already captured one). Live smoke via existing
  `snapshot --print`.
- **ingest:** run against the captured `latest.json`s, assert row counts and
  that the drift join produces the expected red/green for a hand-built case
  (commit newer than deploy → red).
- **dashboard:** load `developer.json` in the running Grafana, eyeball each
  panel against live data.

## Out of scope (v1)

- **domain-developer session activity** — no metric stream exists; surfacing
  it needs a new heartbeat. Explicitly deferred per Jesse. "Developer" here
  is the dashboard's theme, not a live view of the sandbox containers.
- **Workers Builds CI telemetry** (build pass/fail/duration/logs) — not
  exposed to our token. Deploy `source` is the substitute.
- GSC/analytics/earnings — already deferred elsewhere.

## Open questions

None blocking. The registry source (`sites.yml`), token availability, and
both API shapes are all verified.
