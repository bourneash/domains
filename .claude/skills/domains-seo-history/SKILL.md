---
name: domains-seo-history
description: Pull a fleet site's GA4/GSC history and trends for ad-hoc SEO digging and iterative improvement decisions. Use when Jesse asks to "look at <site>'s SEO/traffic history", "how is <site> doing in search", "what's changed for <site>", or wants to decide what to fix/write next based on real data. This is the human-driven, on-demand counterpart to the automated weekly seo-analyst cron role.
---

# SEO/analytics history review

One command against the already-live data-hub pulls a site's real GA4 +
Search Console history and renders a trend report:

```bash
python3 tools/seo-history/seo_history.py <site> [--days 90] [--json]
```

`<site>` is the bare host (`americastrikes.com`, not `https://...`). Run from
the domains repo root; needs no deps beyond stdlib. Data source is
`tools/data-hub`'s `/metrics/*` HTTP API (`http://127.0.0.1:4760` by default,
override with `DATAHUB_API`) — see [[project_fleet_analytics_pipeline]] and
[[project_data_hub]] for how that pipeline is wired.

**Read-only.** It never files tasks or touches site repos — it's for you and
Jesse to look at the data and decide what to do. If a finding should turn
into fleet work, either hand-write the task brief into the site's
`ops/tasks/backlog/` (same format the seo-analyst role uses — see its
archetype at `tools/cron-roles/archetypes/seo-analyst/role.md.tmpl`), or just
wait for that site's Wednesday seo-analyst run to pick it up automatically
(see "Closing the loop" below).

## What it reports

- **Collection health** — GA4/GSC status + last fetch time from
  `/metrics/health`, and whether the site is `consent_gated` (GA4 undercounts
  pre-consent visitors when true).
- **Traffic windows** — sessions/users/conversions/clicks/impressions at
  7d, 28d, and `--days` (default 90).
- **This week vs prior week** — delta with `%` change, computed from
  `/metrics/summary` at window=7 and window=14 (not a naive doubling — it's
  a genuine 7-day-vs-prior-7-day split).
- **Top pages by GA4 sessions** and **top queries by GSC clicks**, over
  `--days`.
- **Opportunity-zone queries** — GSC queries whose impression-weighted
  average position falls in 5-20 (same "worth a refresh or new content"
  band the seo-analyst role hunts for), ranked by impressions.

`--json` dumps the same data as raw JSON if you want to pipe it somewhere
(a report file, a spreadsheet, another script).

## Absence vs zero

If a window shows `no data`, that means data-hub has never collected
anything for that site/window — not that traffic was zero. Check
`/metrics/health` in the report output first: `status` other than `ok`, or a
missing `last_fetch_at`, explains a `no data` window before you read it as a
traffic problem. This mirrors the same rule the seo-analyst cron role and
the Fleet Dashboard Analytics tab both follow — see [[project_fleet_analytics_pipeline]].

## Closing the loop (how sites already act on this data)

The fleet doesn't need a human in the loop to turn this data into site
changes — that pipeline is live already:

- **seo-analyst** runs Wednesday mornings on 6 sites (aliencouncil,
  americastrikes, saveusfarms, ultrarough, weapontester, xxxtea), pulls the
  same `/metrics/summary` and `/metrics/gsc` endpoints this script does,
  and files concrete task briefs into `ops/tasks/backlog/` — `type: content`
  or `type: refresh` to that site's content-writer, `type: engineering` to
  its engineer. Those roles pick the briefs up and ship the change.
- This script is for the gap that cron can't fill: ad-hoc digging outside
  the Wednesday cadence, cross-checking a hunch, or deciding whether a site
  needs a one-off deep look before its next scheduled run.
- To extend the automated side (add a 7th site, change what it hunts for,
  adjust escalation rules), edit the archetype at
  `tools/cron-roles/archetypes/seo-analyst/role.md.tmpl` and follow
  `domains-cron-role-seo-analyst`'s maintain-mode procedure — don't hand-edit
  individual sites' `ops/roles/seo-analyst.md` files directly, they get
  overwritten on the next re-stamp.

## Fleet-wide check

To see every site's collection status at once (not just one site's
history), hit the health endpoint directly:

```bash
curl -s http://127.0.0.1:4760/metrics/health | python3 -m json.tool
```

Or use the Fleet Dashboard's Analytics tab (`http://127.0.0.1:4754/#analytics`,
`FD_TOKEN` login required) for the same data with a per-site picker and
week-over-week badges — see [[reference_fleet_dashboard]].
