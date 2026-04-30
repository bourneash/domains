# Dashboard — Draft Plan

> **Status:** DRAFT, 2026-04-28. Awaiting Jesse review before implementation.
> **Codename (working):** `tools/dashboard/` (the "Domains Console")

## 1. Goal

A single local page (`tools/dashboard/index.html`) that gives Jesse one
glanceable view of the entire domains portfolio: every active site, every
parked domain, with **visual previews and live operational signal** —
not just bookmarks.

The dashboard answers, in five seconds:

1. Which sites are healthy right now?
2. Which sites are **stale** (no commit / deploy / cron run in too long)?
3. Which sites have **work piling up** (open tasks, creds requests)?
4. What does each site actually **look like** right now?
5. What's parked vs. live, and what's the inventory I'm sitting on?

Non-goals (explicitly out of scope, at least for v1):
- Public-facing portfolio site.
- Editing tasks / triggering deploys from the dashboard (read-only).
- Per-site analytics deep dives (link out to GSC/CF instead).
- Any kind of auth / multi-user.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  tools/dashboard/                                               │
│                                                                 │
│  collect.mjs ──┐                                                │
│   (Node 20)    │                                                │
│                ├──► domains.json   ◄─── index.html (vanilla JS) │
│  screenshot.mjs┤                         + thumbnails/*.webp    │
│   (Playwright) │                                                │
│                │                                                │
│  refresh.sh ───┘    one-shot orchestrator; called by cron       │
└─────────────────────────────────────────────────────────────────┘
```

- **Static, file-based.** No server. `open tools/dashboard/index.html` works.
- **Two pure-Node scripts.** No framework. No build step. No `npm install`
  beyond Playwright (already present elsewhere in the repo) and `js-yaml`.
- **Read-only.** The dashboard never mutates a site repo — it reads `git`,
  filesystem, HTTP, and (later) the Cloudflare API.
- **Inventory-driven.** `DOMAINS_INDEX.md` is the source of truth for which
  domains exist; `collect.mjs` parses it (or a thin `domains.yml` we
  introduce — see §9 Open Questions).

## 3. Data model

`tools/dashboard/domains.json` (regenerated each refresh):

```json
{
  "generated_at": "2026-04-28T20:45:00Z",
  "sites": [
    {
      "domain": "americastrikes.com",
      "status": "live",
      "tldr": "Autonomous geopolitics/defense news brand…",
      "url": "https://americastrikes.com",
      "github_url": "https://github.com/bourneash/americastrikes",
      "thumbnail": "thumbnails/americastrikes.com.webp",
      "screenshot_taken_at": "2026-04-28T18:00:00Z",

      "git": {
        "last_commit_at": "2026-04-28T17:15:00Z",
        "last_commit_subject": "fix: brief gap-fill for 04-28",
        "last_commit_sha": "1a2b3c4",
        "branch": "main",
        "uncommitted_changes": false
      },
      "deploy": {
        "last_deploy_at": "2026-04-28T17:32:00Z",
        "deploy_needed_flag": false,
        "cf_worker": "americastrikes"
      },
      "ops": {
        "tasks_backlog": 4,
        "tasks_in_progress": 1,
        "creds_needed_open": 0,
        "last_cron_run": "2026-04-28T13:00:00Z",
        "last_cron_role": "content",
        "last_cron_exit": 0
      },
      "http": {
        "checked_at": "2026-04-28T20:45:01Z",
        "status_code": 200,
        "response_ms": 142,
        "tls_expires_at": "2026-07-19T00:00:00Z",
        "smoke_match": true
      },
      "rollup": "green"
    }
  ],
  "parked": [
    { "domain": "complicated.work", "registered_at": null, "notes": "" }
  ]
}
```

## 4. Metrics — what we capture

Tiered so we can ship tier 1 fast and add later tiers without rework.

### Tier 1 — Free (filesystem + git + parsing)
Per active site:
- `git.last_commit_at`, subject, sha, branch, dirty?
- `deploy.last_deploy_at` — read from `.last-deploy` marker file we drop in
  each repo on successful deploy (small change to existing deploy scripts)
- `deploy.deploy_needed_flag` — presence of `.deploy-needed`
- `ops.tasks_backlog` / `tasks_in_progress` — file count under
  `ops/tasks/backlog/` and `ops/tasks/in-progress/`
- `ops.creds_needed_open` — open checkbox count in `ops/board/CREDENTIALS_NEEDED.md`
- `ops.last_cron_run`, role, exit — read from `ops/.cron-heartbeat.json`
  (new convention; cron wrappers append to this on each fire)
- Built page count — `find dist -name '*.html' | wc -l` after build (optional)

### Tier 2 — Cheap (one HTTP request per site, ~7 requests total)
- `http.status_code`, `response_ms`
- `http.tls_expires_at` (from cert)
- `http.smoke_match` — homepage contains a per-site canary string
- `http.robots_ok`, `http.sitemap_ok`

### Tier 3 — Medium (Cloudflare API; we already have the token)
- Worker requests last 24h / 7d (GraphQL Analytics API)
- Worker error rate (5xx / total)
- Last CF deploy timestamp (cross-check vs. git deploy marker)
- DNS records summary

### Tier 4 — Later (skip in v1)
- GSC impressions / clicks (OAuth setup, defer)
- Plausible / GA4 sessions
- Amazon Associates earnings (no API)

### Status rollup (`rollup`: green / yellow / red)
Computed in `collect.mjs`, surfaced as the card's status dot:

- **red** if any of:
  - HTTP not 200
  - TLS expires in &lt; 14 days
  - Last cron run for a critical role exited non-zero
  - `smoke_match: false`
- **yellow** if any of:
  - No commit in &gt; 7 days for an "active editorial" site (americastrikes,
    aliencouncil, ultrarough, sinderella)
  - `.deploy-needed` flag present (we have unshipped work)
  - Tasks backlog &gt; 10
  - Open creds-needed items &gt; 0
  - TLS expires in &lt; 30 days
- **green** otherwise

Per-site freshness thresholds live in `tools/dashboard/sites.yml` so each
site can tune its own "stale" definition (a game site doesn't need daily
commits the way an editorial site does).

## 5. Components

### `tools/dashboard/sites.yml` (new)
Hand-edited registry. One entry per domain. Carries metadata that
`DOMAINS_INDEX.md` doesn't capture:

```yaml
- domain: americastrikes.com
  status: live
  tldr: "Autonomous geopolitics/defense news brand…"
  url: https://americastrikes.com
  github: bourneash/americastrikes
  cf_worker: americastrikes
  freshness:
    commit_warn_days: 2
    commit_red_days: 5
  smoke_string: "Strikes Brief"
  cadence: editorial   # editorial | game | tool | static | parked
- domain: complicated.work
  status: parked
```

`DOMAINS_INDEX.md` continues to be the human-readable summary; `sites.yml`
is the machine-readable input. We can have `collect.mjs` regenerate
`DOMAINS_INDEX.md` from `sites.yml` so the two never drift.

### `tools/dashboard/collect.mjs`
Orchestrates Tier 1 and Tier 2. Walks `sites.yml`, for each live site:
- shells out to `git -C <site>` for commit data
- reads marker files
- counts task files
- parses creds-needed
- fires an HTTP `HEAD` then `GET` for smoke match
- writes `domains.json`

Tier 3 (Cloudflare) is added as a second pass behind a flag once tier 1
is rendering.

### `tools/dashboard/screenshot.mjs`
Playwright. For each `status: live` site:
- viewport 1280×800, deviceScaleFactor 1
- `goto(url, { waitUntil: 'networkidle' })`
- 600ms settle
- `page.screenshot({ type: 'webp', quality: 70 })` → `thumbnails/<domain>.webp`
- ~600KB per shot at this quality
- Sequential, not parallel — cheap, gentle on origins

### `tools/dashboard/index.html`
Single file. Vanilla JS. `fetch('domains.json')`, render cards into a CSS
grid, sort: red first, then yellow, then green by last-commit desc.
Parked domains in a collapsed section at the bottom.

Card layout (sketch):
```
┌──────────────────────────────┐
│ [thumbnail 16:10]            │
│                              │
├──────────────────────────────┤
│ ● americastrikes.com         │
│ Autonomous geopolitics…      │
│                              │
│ commit  17m ago              │
│ deploy  32m ago              │
│ cron    7h ago (content ✓)   │
│ tasks   4 backlog · 1 wip    │
│                              │
│ [site] [github] [cf] [ops]   │
└──────────────────────────────┘
```

### `tools/dashboard/refresh.sh`
```sh
node collect.mjs        # tier 1 + 2
node collect.mjs --cf   # tier 3 (CF analytics) — optional
node screenshot.mjs     # regenerate thumbnails (slow, weekly)
```

### Heartbeat convention (cross-cutting change)
Each cron-driven role in each site appends to `ops/.cron-heartbeat.json`:
```json
{ "ts": "2026-04-28T13:00:00Z", "role": "content", "exit": 0, "duration_s": 412 }
```
Last 50 entries kept per site. `collect.mjs` reads the latest. This is the
single biggest payoff for ops visibility — implemented as a tiny shell
wrapper around the existing `claude -p …` invocations.

## 6. File layout

```
tools/dashboard/
├── README.md
├── sites.yml              # registry (hand-edited)
├── collect.mjs            # tier 1+2 collector
├── screenshot.mjs         # Playwright thumbnail capture
├── refresh.sh             # one-shot driver
├── index.html             # the dashboard UI
├── styles.css
├── app.js                 # rendering logic
├── domains.json           # generated, gitignored
└── thumbnails/            # generated, gitignored
    ├── americastrikes.com.webp
    └── …
```

## 7. Build sequence

Phased so we get value at each step:

1. **Scaffold + sites.yml** — create the directory, populate the registry
   from `DOMAINS_INDEX.md`. Renders nothing yet.
2. **Tier 1 collect** — git + filesystem only. Generate `domains.json`.
3. **HTML render** — static page that reads `domains.json`, no thumbnails.
   Already useful: card grid, status, freshness, links.
4. **Screenshot pass** — Playwright thumbnails. Cards now visual.
5. **Tier 2 HTTP checks** — status, TLS, smoke. Status rollup goes live.
6. **Heartbeat wrapper** — modify cron entry-points across the 7 sites to
   write `ops/.cron-heartbeat.json`. Surface in cards.
7. **Tier 3 CF analytics** — separate `--cf` collector pass. Adds traffic
   and error-rate columns.
8. **Cron the dashboard itself** — daily `refresh.sh` so `domains.json`
   never goes stale; weekly screenshot regen.
9. **Optional later:** promote to a private subdomain (e.g.
   `dash.bourneash.com`) behind Cloudflare Access if Jesse wants to view
   it from his phone.

## 8. Effort estimate

- Phases 1–3: ~1 session (the visible MVP).
- Phase 4 (screenshots): ~30 min.
- Phase 5 (HTTP + rollup): ~30 min.
- Phase 6 (heartbeats): ~45 min — touches every site repo.
- Phase 7 (CF analytics): ~1 hr.
- Phase 8 (cron): ~15 min.

So the whole thing is one focused day of work, fully landable in pieces.

## 9. Open questions

1. **`sites.yml` vs. parse `DOMAINS_INDEX.md` directly?** Recommend
   `sites.yml` as the source of truth and *generate* `DOMAINS_INDEX.md`
   from it. Less drift, more metadata.
2. **Where do thumbnails live?** `tools/dashboard/thumbnails/` (gitignored)
   for now. If we later make this public, regen on a schedule and commit.
3. **Heartbeat format — JSON vs. SQLite?** JSON is simpler and survives
   forever; SQLite is overkill for &lt;50 events/day/site. JSON.
4. **Should the dashboard fetch live data on page load?** No — all data
   precomputed. The page is a static reflection of the last `refresh.sh`.
   Avoids CORS, CSP, and "is the site flaky right now" UI flicker.
5. **Run on a schedule?** Yes, eventually (phase 8). Not for v1.
6. **Cards for parked domains?** Compact row, no thumbnail (no live site to
   shoot). Just domain + registrar + "claim" button (link to a "what to
   build here" doc, future work).

## 10. What we get when this is done

- One URL (`file://…/tools/dashboard/index.html`) that's the homepage of
  the entire domains operation.
- Every cron-driven site self-reports health into one place.
- Stale work surfaces immediately (yellow / red dots).
- A weekly visual record of how each site looks — useful when reviewing
  whether the editorial loop is actually shipping changes.
- The bones of a public portfolio later, if we want it.
