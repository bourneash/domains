# social-hub — fleet social media management platform

One control plane for every site's social presence: content queue, scheduler,
AI drafting, approval/editing, publishing, and a reply inbox — with an HTTP API
underneath all of it.

```
sites/<domain>/site/src/content   ──ingest──▶  sources
                                                 │  AI drafting (voice + guardrails)
                                                 ▼
   Vaultwarden creds  ──▶  channels  ◀──────  queue ──approve──▶ schedule ──▶ publish
   social registry    ──▶     │                  ▲                              │
                              └── inbox ──AI──▶ replies                   ops/social/post-log.jsonl
```

## Why not an off-the-shelf tool

Mixpost and Postiz are the credible self-hosted options and both were
considered. Neither fits this fleet: they are workspace-shaped (one brand at a
time, ~25 sites of manual setup), they cannot read the site repos to know a new
article exists, they cannot read credentials out of the existing Vaultwarden
org or honour the social registry's `suspended` kill switch, and they assume
official platform API apps this fleet does not have for every network. The
scheduling and approval machinery is the small part; the fleet integration is
the whole value. So: build, reusing what already exists.

Reused rather than rebuilt: `social-setup`'s registry (account inventory),
`social-lib`'s vault store (credentials), `social-poster`'s content loader
(per-site content layouts), `claude-tracked.sh` (AI cost ledger), the site's
own `ops/social/post-log.jsonl` (publication history), the shared Slack bot.

## Quick start

```bash
pip install -e tools/social-hub --no-deps       # deps are already fleet-wide
social-hub doctor                               # environment check
social-hub channels sync                        # mirror the social registry
social-hub tick --site americastrikes.com       # one full pipeline pass
social-hub serve                                # UI + API on 127.0.0.1:4772
```

## Opting a site in

Create `sites/<domain>/ops/social/hub.yaml`. Its presence is the switch —
there is no fleet-wide enable, on purpose ([[feedback_no_auto_rollout_tool]]:
rollouts stay deliberate and per-site). Everything not set falls back to
`tools/social-hub/config/fleet.yaml`.

```yaml
enabled: true
platforms: [bluesky, console]
approval: manual            # or auto — per platform via platform_overrides
variants_per_source: 1
max_source_age_hours: 48
cadence:
  per_platform_per_day: 4
  min_gap_minutes: 90
  quiet_hours: [4, 10]      # UTC, wraps midnight
  slots: ["12:00", "17:30", "21:00"]
reply:
  enabled: true
  approval: manual
  max_per_day: 8
  ignore_keywords: [crypto, giveaway]
voice: >-
  How this brand sounds, in two or three sentences.
ai:
  guardrails: >-
    The things the model must never do for this brand.
platform_overrides:
  reddit:
    subreddit: r/example     # community routing is config, never a model choice
  console:
    copy_from: bluesky       # mirror channel — reuse the copy, don't pay twice
```

`sources.globs` + `sources.url_template` handle sites whose postable content
isn't `site/src/content/articles/` — `{collection}` in the template resolves to
the containing directory, so articles and briefings can share one rule.

Live examples: `sites/americastrikes.com/ops/social/hub.yaml` (auto-posting)
and `sites/0daynews.com/ops/social/hub.yaml` (manual review, 2 variants).

## The pipeline

`social-hub tick` runs one idempotent pass and is what cron calls:

| Stage | What it does |
|---|---|
| channels | mirrors the social registry; `suspended` there disables the channel here |
| ingest | finds new site content; anything past `max_source_age_hours` is recorded but never queued |
| generate | drafts copy per platform, in the site's voice, under the platform's char limit |
| inbox | pulls mentions/replies for channels whose platform supports it |
| replies | filters, then drafts answers (the model may decline; there is no canned fallback) |
| metrics | refreshes engagement counts on recent posts (often on day one, rarely after) |
| publish | sends everything due, mirrors it to the site's `post-log.jsonl` |

Overlapping runs are safe: publishing claims rows (`status='publishing'`),
ingestion is keyed on `(site, source_id)`, and drafting checks for an existing
draft first.

### Post lifecycle

```
draft ──approve──▶ scheduled ──▶ posted
  │                    └──fail──▶ retry ×3 (5/20/80 min) ──▶ failed
  └──reject──▶ rejected   (and the article goes back in the pool)
```

## Platforms

| Platform | Post | Reply | Inbox | Images | Metrics | Notes |
|---|:--:|:--:|:--:|:--:|:--:|---|
| bluesky | ✅ | ✅ | ✅ | ✅ | ✅ | reference implementation; accounts vaulted fleet-wide |
| mastodon | ✅ | ✅ | ✅ | ✅ | ✅ | token only, no app review |
| x | ✅ | ✅ | ⚠️ | — | ⚠️ | mentions/metrics need a paid tier; degrades to post-only |
| reddit | ✅ | ✅ | ✅ | — | — | parked fleet-wide (OAuth app creation blocked) |
| pinterest | ✅ | — | — | ✅ | — | needs a business account + approved v5 app |
| console | ✅ | ✅ | ✅ | ✅ | — | local JSONL outbox — onboard new sites here first |

Adding one is a single file in `platforms/` plus a line in the registry; the
scheduler routes by declared capability, so a post-only platform never has
replies generated for it.

## Interfaces

- **UI** — `social-hub serve`, then http://127.0.0.1:4772 — overview, queue
  (inline editing, approve/reject/post-now/reschedule), 14-day calendar, inbox,
  insights (engagement + top posts), channels, activity log.
- **API** — same host under `/api`, OpenAPI at `/api/docs`. Set
  `SOCIAL_HUB_TOKEN` to require a bearer token.
- **Fleet Dashboard** — Growth ▸ **Social Hub** (http://127.0.0.1:4754/#socialhub)
  shows per-site queue state, everything awaiting review with approve/reject,
  and 30-day engagement. It proxies this API, so the hub must be running and
  reachable from the panel's container: `social-hub serve --host 0.0.0.0` with
  `SOCIAL_HUB_TOKEN` set (the hub refuses to bind off-loopback without one).
  Both are installed in cron — a 15-minute tick and an `@reboot` serve.
- **CLI** — `social-hub --help`; `status`, `queue`, `compose`, `approve`,
  `publish`, `inbox`, `metrics`, `channels`, `tick`, `doctor`.

## Operations

Install the cron tick (every 15 minutes):

```bash
tools/social-hub/cron/install-cron.sh
```

Health rules of thumb: `social-hub status` shows per-site queue counts, next
send, and inbox depth; `social-hub doctor` catches missing channels and
credentials; failures and review backlogs go to the site's Slack channel, and
healthy runs stay silent.

## Images

Posts carry the article's cover automatically on platforms that support it.
The image is read from the site checkout first (`site/public/...`), falling
back to HTTP, resized under the ~950KB blob ceiling, and captioned with the
article title as alt text. A missing or oversized image costs the post its
picture, never its publication. `SOCIAL_HUB_NO_MEDIA=1` disables attachments.

## Engagement

`social-hub metrics [--refresh]` reports likes/reposts/replies per platform
and the top posts, and the tick refreshes counts on a decaying ladder — every
45 minutes on a post's first six hours, daily after three days, not at all
after two weeks. Deliberately shallow: enough to answer "which copy worked",
without needing an analytics-tier API.

## Data

`data/hub.db` (SQLite, gitignored) holds queue and schedule state. It is
deliberately not the system of record for what was published — every send is
mirrored into the site's own `ops/social/post-log.jsonl`. Losing the DB loses
pending schedule state, never history.

## Tests

```bash
cd tools/social-hub && python3 -m pytest -q
```

The suite runs against a temporary fake fleet (own DOMAINS_ROOT, registry, DB,
and a recording adapter) — no network, no vault, no real repo.
