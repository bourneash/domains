# Fleet Analytics Pipeline — GA4 + Search Console Capture

**Date:** 2026-07-18
**Status:** Approved design (pre-implementation)
**Location:** `tools/google-auth/`, `tools/gsc-verify/`, `tools/ga4-provision/`, `tools/data-hub/`, `tools/fleet-dashboard/`

## Problem

16 live sites emit GA4 events. **Nothing collects that data, and Search Console was never verified.**

- **GA4 is wired, unread.** All 16 live sites carry a real measurement ID under account
  396394354 "Domain Portfolio". A fleet-wide grep for `analyticsdata.googleapis.com`,
  `google-analytics-data`, or `BetaAnalyticsData` returns zero hits. No Data API client exists.
- **GSC is not verified on a single property.** Blocker open since 2026-05-06
  (`sites/aliencouncil.com/ops/tasks/backlog/seo-gsc-submit-2026-05-06.md`,
  `sites/0daynews.com/ops/tasks/backlog/2026-07-15-blocker-google-search-console-verification.md`).
- **The `seo-analyst` cron role has been a no-op for ~10 weeks.** Its role template declares GSC as
  input #1 (`tools/cron-roles/archetypes/seo-analyst/role.md.tmpl:25-30`) but names no path, API, or
  credential, and carries an escape hatch at `:43-44` — *"Log if GSC credentials are not yet
  available ('Blocked on Jesse — GSC verification pending') and move on."* The latest real run
  (`sites/0daynews.com/ops/logs/seo-analyst-2026-07-15-0600.log`) reads *"GSC still not verified.
  Third consecutive Wednesday without query data."* The role is disabled on 6 of 8 sites.
- **Every stored SEO artifact is fiction.** `sites/aliencouncil.com/ops/seo/gsc-2026-W19.json` and
  `gsc-2026-W24.json` are all-null with `"status": "PRE-INDEXATION (GSC not yet configured)"`,
  hand-written by the seo-analyst LLM. `rank-history.csv` is every row `NR / site not indexed`.
  Repo-wide grep finds zero producing scripts. The **only** file in the fleet with real search
  numbers is `sites/xxxtea.com/ops/board/seo-audits/xxxtea.com.jsonl` — one record, 2026-06-15,
  15 clicks / 386 impressions, transcribed off a screenshot by hand.
- **The one working path is a screenshot scraper.** The `domain-seo-check-stats` skill drives
  CloakBrowser through the GA4 web UI, captures 8-10 PNGs, and has a model read the pixels. It
  requires Jesse logged in at a visible browser for 120 seconds. It cannot run unattended.
- **A prior attempt was abandoned.** `tools/auth-google/` (2026-06-13, commit f04de18) is an OAuth
  scaffold whose own completion message promises *"gsc-fetch and ga4-fetch tools"*
  (`setup.mjs:97`) that were never written. The flow was never completed — `.gcp/` creds exist,
  `.env` holds no `GOOGLE_*` keys. `tools/DASHBOARD_BACKLOG.md:97-98` lists this work under
  *"Explicitly deferred (out of v1, may never)."*

Consequence: no fleet agent and no human can answer "which page is losing impressions," "what
query should we build against," or "did that rewrite work."

## Goals

1. **Unattended daily capture** of GA4 and GSC metrics for every live site, no human in the loop.
2. **Unblock GSC verification** across all 16 domains, programmatically.
3. **One queryable store**, agent-first: cron roles read metrics over HTTP, same as any data-hub source.
4. **Human read view** in the Fleet Dashboard, on the same store.
5. **Preserve history GA4/GSC will not.** GSC retains 16 months on a rolling basis; our store is permanent.
6. **Delete the dead scaffold** left by the prior attempt.

## Non-Goals

- Not replacing the `domain-seo-check-stats` or `domains-google-analytics-ga4-admin` skills. Both
  are retained. The GA4-admin skill remains the provisioning path for new properties.
- Not adding analytics to the 20+ non-live sites in `sites/` that carry no measurement ID.
- Not building rank tracking, competitor data, or third-party SEO APIs.
- Not moving GSC data into `site-tracker` facts. Metrics are time-series; site-tracker is current-state.

## Key API Constraints (drive the architecture)

**The Search Console API cannot grant access.** `searchconsole/v1` exposes `sites.*`,
`searchanalytics.query`, `sitemaps.*`, `urlInspection` — no permissions endpoint. User management
is UI-only. **Resolution:** the service account performs DNS-TXT verification *itself* via the Site
Verification API; successful verification makes the verifying identity a verified **owner**. No
grant step is needed. Multiple TXT records coexist, so Jesse verifying separately as himself for
web-UI access does not conflict.

**GA4 is the mirror image.** The Admin API *does* expose `accessBindings.create`, but a service
account cannot grant itself access to properties it cannot see. **Resolution:** one interactive
OAuth-as-Jesse run, once, porting the existing `tools/auth-google/setup.mjs` flow (which already
requests the correct scopes at `:21-22`). After that single run the service account handles all
recurring work; no refresh token is retained or babysat.

**Quota is not a constraint.** Verified 2026-07-18:
- *Search Console:* 1,200 QPM per site, 1,200 QPM per user, 30M QPD per project. Daily incremental
  is ~3 requests/site × 16 sites ≈ 48 requests/day.
- *GA4 Data API:* 200,000 core tokens per property per day, 40,000/hour, 10 concurrent — all
  **per property**, so sites do not compete. Most requests cost ≤10 tokens.
- *Backfill technique:* request a date range with `date` as a **dimension**, chunked ~3 months per
  call — ~6 calls per property for 16 months, not 487. The 40k/hour per-property ceiling is the
  only one worth staggering against.

## Architecture

```
  ┌─ one-time ─────────────────────────────────────────────────┐
  │ tools/ga4-provision   (OAuth as Jesse → accessBindings)    │
  │ tools/gsc-verify      (SA self-verifies via CF DNS TXT)    │
  └──────────────────────────┬─────────────────────────────────┘
                             │ grants + verifies
  ┌─ recurring ──────────────▼─────────────────────────────────┐
  │ tools/data-hub  metrics collector (daily cron, policy:direct)│
  │   ├ metrics/ga4.py   → ga4_metrics                          │
  │   └ metrics/gsc.py   → gsc_metrics                          │
  │                      SQLite (WAL) → FastAPI :4760           │
  └──────────────┬───────────────────────────┬─────────────────┘
        /metrics/*                    /metrics/*
   Fleet Dashboard :4754          seo-analyst cron role
   "Analytics" tab                (16 sites)
```

### 1. `tools/google-auth/` — shared credential library

Replaces the dead `tools/auth-google/` scaffold. Single place service-account creds are read.

- Loads `/home/jesse/projects/domains/.gcp/service-account.json` (genuine key, dated 2026-06-10,
  gitignored via `.gitignore:7`).
- Returns scoped clients: GA4 Data, GA4 Admin, Search Console, Site Verification.
- Python, matching data-hub's stack. `ga4-provision` is the sole Node consumer and keeps
  `google-auth-library` (root `package.json:3`).
- Fails loud and specific when the key is missing or a scope is unauthorized — never silently degrades.

### 2. `tools/ga4-provision/` — one-time, interactive

Ports the OAuth installed-app flow from `tools/auth-google/setup.mjs`. Authenticates **as Jesse**,
then `accessBindings.create` adding the service account as **Viewer** on all 16 GA4 properties.
Prints a per-property result table and exits. Idempotent: an existing binding is reported, not
duplicated. Retained after first run for onboarding new sites.

Property IDs come from `registry/sites-analytics.yaml` (below), which supersedes the two stale
hardcoded dicts (`domain-seo-check-stats/scripts/ga-seo-audit.py:30-46` has 13 entries;
`domains-google-analytics-ga4-admin/SKILL.md:113-133` has 15).

### 3. `tools/gsc-verify/` — idempotent CLI

Per domain, in order, skipping any step already satisfied:

1. Query verification state via Site Verification API.
2. If unverified: request the DNS TXT token.
3. Write the TXT record via the Cloudflare API (token already in `.env`, DNS edit rights on all zones).
4. Poll DNS until the record resolves (bounded backoff, explicit timeout).
5. Call `verify` **as the service account** → SA becomes verified owner.
6. `sites.add` the domain property.
7. Submit the sitemap.

Re-runnable at any time; reports a table of what changed. This is the step that has been blocked
manually since 2026-05-06.

### 4. `tools/data-hub` additions

**Registry — `registry/sites-analytics.yaml`.** Single source of truth, one entry per live site:

```yaml
sites:
  saveusfarms.com:
    ga4_property_id: "123456789"
    ga4_measurement_id: G-GDYX2GPMMJ
    gsc_property: "sc-domain:saveusfarms.com"
    consent_gated: true     # GA4 loads only after explicit consent
```

**Fetchers — `src/datahub/metrics/ga4.py`, `src/datahub/metrics/gsc.py`.** Sit alongside the ten
existing `src/datahub/datasets/` modules and follow their shape (typed fetcher, per-source failure
isolation, no run-wide failure from one dead site).

**Store — two typed tables** (not a `metrics JSON` blob; agents and the dashboard sort and
aggregate on these constantly, and `json_extract` in every `ORDER BY` is a tax with no upside when
the metric sets are stable and known):

```sql
gsc_metrics(site, date, grain, dim_key,
            clicks, impressions, ctr, position, fetched_at,
            UNIQUE(site, date, grain, dim_key))

ga4_metrics(site, date, grain, dim_key,
            sessions, users, new_users, views, engaged_sessions,
            engagement_rate, avg_session_duration, conversions, fetched_at,
            UNIQUE(site, date, grain, dim_key))
```

`grain` ∈ `site | page | query | page_query`. `dim_key` holds the URL, query, or tab-joined pair;
empty string at `site` grain. Indexes on `(site, date)` and `(site, grain, dim_key)`.

**Trailing re-pull, not append.** Both APIs restate recent data — GSC lags ~2-3 days and revises,
GA4 finalizes over ~24-48h. The collector re-pulls a **7-day trailing window** and upserts on the
UNIQUE key. Appending instead of upserting is the single most common way this class of pipeline
ends up quietly wrong.

**Retention carve-out.** `DATAHUB_RETENTION_DAYS` prunes `items` at ~7 days. Metrics tables MUST be
exempt from that sweep. This is the one dataset whose loss is unrecoverable — GSC's 16-month window
is rolling, so history not captured is gone permanently.

**VPN policy `direct`.** Data-hub routes egress through PIA fail-closed. Authenticated Google API
calls from rotating PIA exits invite blocks and auth friction. Google API sources use the sanctioned
direct-path carve-out already established in the data-hub design for gov APIs — explicit, logged,
and visible in `egress_log`.

**Cron.** Daily, staggered per site — a separate schedule from the `*/30` RSS collector cycle.
Every GA4 request passes `returnPropertyQuota: true`; observed token spend is logged rather than assumed.

**API — new endpoints** in `src/datahub/api.py` (alongside the existing routes at `:63-163`):

```
GET /metrics/ga4?site=&since=&until=&grain=&limit=
GET /metrics/gsc?site=&since=&until=&grain=&limit=
GET /metrics/summary?site=&window=28d        # totals + WoW/MoM deltas
GET /metrics/top?site=&source=&grain=&metric=&window=&limit=
GET /metrics/health                          # per-site last-capture, freshness, quota spend
```

### 5. Backfill

One-shot command, separate from the daily cron.

- **GA4:** ~16 months, chunked ~3 months per request with `date` as a dimension. ~6 calls per property.
- **GSC:** accumulates forward from verification day. Nothing to backfill — the data does not exist
  for us until the property is verified, which is why verification is sequenced first.

### 6. Fleet Dashboard — "Analytics" tab

`server/analytics.js`, modeled on `server/datahub.js:6` (the established remote-service provider
pattern). Registered in `createApp()` (`server.js:68+`), tab button in `index.html:15-27`, plus
`TOP_VIEWS` entry and `render()` branch (`app.js:2111-2125`).

Surfaces: per-site sessions/users trend, top pages, top queries, clicks/impressions/CTR/position,
WoW deltas, capture freshness.

**Consent-gated sites are marked.** `saveusfarms.com` (`suf_analytics_consent`, loads only on
`suf-consent-granted`) and `weapontester.com` gate GA4 behind explicit consent, so they report only
consented traffic and read materially lower than reality. The dashboard labels them rather than
silently ranking them against ungated sites.

### 7. `seo-analyst` cron role rewire

Replace the "Blocked on Jesse" escape hatch (`role.md.tmpl:43-44`, `:86`) with real `/metrics`
queries: opportunity zones from actual impressions/position data, decay detection from WoW deltas.
Add the hub endpoint to `meta.yml` (`worker_deps`/`scripts` are currently empty at `:13`).
Re-enable on the 6 sites carrying `ops/.seo-analyst-disabled` (aliencouncil, americastrikes,
saveusfarms, ultrarough, weapontester, xxxtea).

### 8. Dead code removal

- **`tools/auth-google/`** — orphaned. Committed once (f04de18), never touched. Zero inbound
  references fleet-wide; the only hits outside itself are lines in a 0daynews engineer log from the
  `.monorepo-tools` leak incident. `setup.mjs`'s OAuth flow is ported to `ga4-provision` first, then
  the directory is deleted. `test.mjs` deletes outright — it probes the GA4 Admin API and reads no metrics.
- **`tools/site-tracker/src/site_tracker/collectors/search_consoles.py`** — a 13-line stub whose
  entire body logs *"v2 stub; no facts emitted."* It is live-registered in `COLLECTORS`
  (`cli.py:30`) and runs on every collection pass doing nothing. Delete the file, its import
  (`cli.py:20`), and its registration.

**Retained:** `.gcp/service-account.json` (becomes load-bearing), `google-auth-library` in root
`package.json` (used by `ga4-provision`), and **all skills** — `domain-seo-check-stats` and
`domains-google-analytics-ga4-admin` both stay.

## Data Flow

1. **One-time:** `ga4-provision` grants the SA Viewer on 16 properties; `gsc-verify` verifies 16
   domains via CF DNS TXT, making the SA owner.
2. **Daily:** metrics collector pulls a 7-day trailing window per site from both APIs → upserts into
   `ga4_metrics` / `gsc_metrics` → logs egress + quota spend.
3. **On demand:** Fleet Dashboard and `seo-analyst` read `/metrics/*` over HTTP.

## Error Handling

- **Unverified / unauthorized property:** skipped, flagged in `/metrics/health`, run continues.
  Never fabricates a zero row — absence of data must not read as measured zero.
- **Quota exhaustion:** exponential backoff, partial results committed, resume next cycle.
  `returnPropertyQuota` spend logged every call.
- **DNS propagation timeout in `gsc-verify`:** that domain reports `pending`, others proceed;
  the TXT record is left in place so a re-run resumes rather than restarting.
- **Single-site fetch failure:** isolated per-site, matching existing data-hub per-source isolation.
- **Hub unreachable from a consumer:** dashboard shows stale-with-timestamp; `seo-analyst` logs and
  skips. Neither fabricates data.
- **GSC row sampling on large query pulls:** cap rows per day per grain rather than reducing grain.

## Testing

- **Per-fetcher unit tests** with recorded API fixtures (GA4 + GSC), matching the existing
  `datasets/` fetcher test pattern.
- **Upsert idempotency test** (the critical one): re-pull the same trailing window twice → zero
  duplicate rows, revised values overwrite. This guards the trailing-window design.
- **Retention test:** run the `items` prune sweep → assert metrics tables untouched.
- **`gsc-verify` dry-run** against a single scratch domain before the fleet run, asserting the TXT
  record is written and cleaned up correctly.
- **API contract tests** for each `/metrics/*` endpoint including empty-data cases.
- **Absence-vs-zero test:** a site with no data returns absent, not `0`.

## Build Order

1. `tools/google-auth/` — everything depends on it.
2. `tools/ga4-provision/` — interactive step; unblocks real data fastest.
3. `tools/gsc-verify/` — clears the 10-week blocker.
4. data-hub fetchers + tables + `/metrics` endpoints.
5. Backfill (GA4 16 months).
6. Fleet Dashboard Analytics tab.
7. `seo-analyst` rewire + re-enable on 6 sites.
8. Dead code removal (`tools/auth-google/`, `search_consoles.py`).

Steps 2 and 3 are independent and may run in parallel. Step 8 lands only after 1-7 prove out.

## Open Risks

- **GA4 property IDs are not yet collected in one place.** The two existing hardcoded dicts disagree
  (13 vs 15 entries) and both are stale against 16 live sites. Building
  `registry/sites-analytics.yaml` requires one pass against the GA4 Admin API (`properties.list`) to
  get authoritative IDs — folded into step 2.
- **Domain-property vs URL-prefix in GSC.** Design assumes `sc-domain:` domain properties (DNS
  verification, covers all subdomains and protocols). Any site needing URL-prefix granularity would
  need a second property; none currently does.
- **Consent-gated GA4 undercounts** on saveusfarms and weapontester. Marked, not corrected — there
  is no honest correction factor.
