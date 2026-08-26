---
ticket_id: 2026-08-25-news-writer-reads-all-200-raw-feed-items-124kb-into-context
status: applied
title: news-writer reads all 200 raw feed items (124KB) into context each run
created: 2026-08-25
decided: 2026-08-25
applied: 2026-08-25
applied_commit: d9ef6040 (sites/0daynews.com)
applied_note: implementer applied+committed this at 18:11; queue tracking lagged (Bash EROFS session bug at 17:51, github-bourneash DNS push-check noise at 18:14, then the fleet OAuth outage 19:31-20:51 made every retry re-alert). Confirmed d9ef6040 is on origin/main and matches the proposed change; moved to applied manually.
finding_class: raw-feed-context-bloat
dedupe_key: fb395d184072b1f0
scope: site
sites: [0daynews.com]
role: news-writer
window_from: 2026-08-11
window_to: 2026-08-25
measured_cost_usd: 82.98
risk: medium
verified_current_code: true
verified_git_check: git log -3 ops/roles/news-writer.md — most recent commits (0a423af3, 7fde19d1, 1efaa7df) fixed build-log noise, turn budget, and persona routing; NONE touched feed reading. ops/scripts/ has pull-feeds.py only, no pre-filter exists. Behaviour is current.
evidence_files: [sites/0daynews.com/ops/roles/news-writer.md:126, sites/0daynews.com/ops/cache/news-feed.json]
decided_by: dashboard
---

## Problem

news-writer.md instructs the agent to read ops/cache/news-feed.json directly. That file is currently 200 items / 123,368 bytes and stays resident in context for the whole session. On a 20-30 turn run that is re-billed as cache-read on every subsequent turn.

This is the same class of waste as the build-log fix (0a423af3) and the persona-routing extraction (1efaa7df) — both of which cut context the agent did not need — but the feed has NOT been addressed.

## Proposed change

A pre-filter script (zero AI cost, same pattern as build-article-index.py / route-persona.py) that scores the feed and hands the session a top-N candidate list plus a one-line summary each, instead of all 200 raw items.

## Risk — why this is NOT auto-appliable and needs a real decision

This puts a deterministic filter between the model and 'what counts as newsworthy'. Today that judgment is the model's, over the full feed. A bad ranking heuristic could bury the one story that mattered, and the failure is silent — you would see nothing but a slightly worse site.

Recommend: if approved, run the filter in SHADOW first (log what it would have hidden, keep feeding the full list) for a week, and diff against what the writer actually picked. Only then cut over.

## Note on the measured figure

$82.98 is the role's TOTAL 14-day spend, not the feed's isolated share — the ledger cannot attribute cost to one context component. Treat it as the ceiling this finding draws from, not the savings.
