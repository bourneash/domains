---
ticket_id: 2026-08-28-amputeenews-com-content-writer-article-count-gate-doesn-t-ca
status: applied
title: "amputeenews.com content-writer: article-count gate doesn't catch empty sessions when feed has no new material"
created: 2026-08-28
decided: 2026-08-28
applied: 2026-08-28
applied_commit: 1236712 (sites/amputeenews.com)
applied_note: implemented mark-seen unseen-URL gate + queued-task check in content-writer-gate.py, mirroring 0daynews.com/ops/scripts/writer-gate.py; fail-open (RUN) on any feed read error; run-role.sh calls --mark-seen only after a successful session.
finding_class: missing-new-material-gate
dedupe_key: 448b190292e8cfc6
scope: site
sites: [amputeenews.com]
role: content-writer
window_from: 2026-08-22
window_to: 2026-08-28
measured_cost_usd: 17.58
estimated_savings_usd_per_day: 0.81
risk: medium
verified_current_code: true
verified_git_check: "Read sites/amputeenews.com/ops/scripts/content-writer-gate.py in full (lines 32-78). The gate has DAILY_CAP=3 and checks published: frontmatter across articles/ and guides/. It returns SKIP only when today_count >= 3. There is no feed-freshness or mark-seen check. Compared with 0daynews.com/ops/scripts/writer-gate.py which adds a URL-seen check on top of its article cap — amputeenews has no equivalent. Math: 31 sessions over 7 days = 4.43/day average. With a 3-article/day cap, the gate returns SKIP once 3 articles are published. Sessions beyond 3/day that actually billed Claude must have produced 0 articles (otherwise the gate would have blocked them). 31 - 21 minimum = ~10 empty sessions over the window × $0.567/session = $5.67 week-window waste, ~$0.81/day ongoing."
evidence_files: ["sites/amputeenews.com/ops/scripts/content-writer-gate.py:32", "sites/0daynews.com/ops/scripts/writer-gate.py:1"]
---

## Problem

`content-writer-gate.py` (line 32) sets `DAILY_CAP = 3` and returns SKIP only once that many articles/guides have `published:` today. It has no check for whether the data-hub feed (`ops/cache/news-feed.json`) contains anything the writer hasn't already seen.

Result: the cron fires every 3 hours (8x/day). Once 3 articles are published the gate skips the rest — correct. But on any tick before the cap is hit, if the feed hasn't changed since the last session, Claude is invoked again and produces nothing, because the writer already judged and passed on the same URLs. The gate doesn't know this and lets the session run.

Measured evidence: 31 billing sessions over 7 days = 4.43/day. The 3-article/day cap means the gate can only return SKIP once today_count ≥ 3. For sessions to average 4.43/day, at least 1.43 sessions/day must have produced 0 output (otherwise the cap would have fired sooner). 10 estimated empty sessions × $0.567 = $5.67 wasted this window.

## Proposed change

Add a mark-seen / unseen-URL check to `content-writer-gate.py`, mirroring the pattern in `0daynews.com/ops/scripts/writer-gate.py`:

1. After each successful session, call the gate with `--mark-seen` to record which feed URLs were shown.
2. At the top of the gate (before the article-count check), compare `ops/cache/news-feed.json` URLs against the seen set. If every URL has been seen AND no `type: content` backlog task exists, return SKIP at zero cost.

**Implementer note:** amputeenews content-writer also writes guides that are not strictly tied to new feed items. The implementer should decide whether to restrict the skip to news-article mode only (e.g., only skip if no backlog task exists AND feed is unchanged) or allow it to skip guide-writing sessions as well. A conservative approach: only add the backlog-task check for now (skip if feed unchanged AND no queued task), accepting that guide-writing sessions on a stale feed still run.

## Risk

Medium. The gate change is additive (only skips when feed is provably stale), but if the mark-seen state becomes stale or corrupted, it could block legitimate sessions. The implementer should ensure the fallback is RUN (not SKIP) on any read error, as 0daynews writer-gate.py does.

## Verification

Read `content-writer-gate.py` lines 32-78: no feed-freshness logic present. `news-feed.json` confirmed in `ops/cache/`. Analogous gate pattern confirmed at `0daynews.com/ops/scripts/writer-gate.py`. Waste math: 31 sessions - 21 minimum (3/day × 7 days) = 10 excess sessions × $0.567/session = $5.67 over the window.
