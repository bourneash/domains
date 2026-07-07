# News aggregation + autonomous editorial

Reference implementations: **`americastrikes.com`** (defense/geopolitics news, hourly-capable
autonomous loop) and **`aliencouncil.com`** (editorial editions + live data trackers). Read
`sites/americastrikes.com/CLAUDE.md` and `TODO.md` first — they are the live blueprint. Note: a fresh
scaffold (e.g. broadwayshowgirls) ships with a `/news/` index but **no aggregation engine yet** — you
build it from the americastrikes pattern when the brief calls for it.

## What "aggregation" means here

It is not a scraper farm. The loop is: scan the news for the gap window since the last published
edition → synthesize original editorial (briefings, articles, case files) in the brand's voice →
attach dated metadata → build → push → smoke the live URLs → log to the board. The model does the
synthesis; scripts handle freshness detection, building, and verification.

## The `<site>.com-update` editorial-cycle skill

Every news site gets a headless, cron-safe skill named `<site>.com-update` that runs one full refresh
cycle. Pattern to copy: the `americastrikes.com-update` and `aliencouncil.com-update` skills. Key
properties:

- **Gap-aware:** detects the latest existing article/edition and backfills the window since — safe to
  run hourly, daily, or weekly; it self-adjusts.
- **No interactive prompts:** runs inside a cron container with no TTY.
- **Self-contained cycle:** scan → draft the stalest artifact (article / briefing / edition) → bump
  edition number → build → push → smoke live URLs → append to `ops/board/BOARD_REPORT.md`.
- For sites with live trackers (aliencouncil's disclosure tracker, 3I/Atlas data), refresh that data
  in the same cycle.

**Don't hand-rebuild the skeleton — stamp it.** Run the scaffolder to drop a faithful structural
skeleton (gap-aware mode table, the full publish cycle, build/smoke gates, failure modes, cron
wiring), then fill the site-specifics:

```bash
bash /home/jesse/projects/domains/.claude/skills/skills-domains-build-new-site/scripts/scaffold-update-skill.sh <domain.tld>
```

It writes `.claude/skills/<domain>-update/SKILL.md` (commits with the repo; container sees it via the
repo mount) with `FILL:` markers for everything site-specific — content collections, beats/personas,
voice law, smoke script, sources, cadence. Resolve every marker against the site's brief +
`site/src/content.config.ts`, and delete steps the site lacks (a persona/review site usually drops the
news-scan, IndexNow, and social-queue steps). The reference fills to study while resolving markers:
`americastrikes.com-update` (two content types, news scan, image pipeline) and `aliencouncil.com-update`
(single edition + live trackers). Then create the wrapper role `ops/roles/update.md`, add the cron line
to `ops/docker/crontab.docker`, and register it via the cron-role family.

Build this skill as part of Phase 6 and register its cron via the cron-role family.

## Autonomous publishing ops (Phase 6)

Install the cron roles with the **`domains-cron-role-*`** skills:
- `content-writer` — drafts/publishes editorial on a cadence (and, for persona sites, the daily
  random co-authored piece).
- `engineer` — 4-hourly true-render health check, safe auto-fixes behind a build gate, Slack
  heartbeat.
- `affiliate-editor`, `planner`, `seo-analyst`, `watchdog`, `maintainer` — as the site needs.

Wire Slack with **`domains-connect-site-to-slack`** so role runs post failures + high-signal successes
to the site's own `domain-<host>` channel. Remember the runner gotchas: the runner site must exist
first, the bot must be `/invite`d to the channel, and `notify-slack.sh` must be `chmod +x`.

## Editions, dates, and honesty

Date each artifact to the day the news actually happened (case files are dated to the event, not the
publish run). Keep an edition counter. Never fabricate events to fill a slow window — a thin honest
edition beats an invented one, and the brand's credibility is the asset.
