---
ticket_id: 2026-08-29-0daynews-com-news-writer-scan-mode-fallback-1-turn-short-36
status: rejected
rejected_reason: >
  Wrong direction — raising the cap papers over the overrun instead of fixing
  it. Jesse wants turn usage DOWN, not the ceiling UP. Root cause addressed
  instead: news-writer.md now reads ops/cache/feed-candidates.json (top-30,
  scored) instead of the full 200-item news-feed.json, cutting the per-turn
  cache-read context ~90% and removing the reasoning load that was driving
  the overrun in the first place. See ops/roles/news-writer.md and
  ops/scripts/filter-feed.py (2026-08-29 cutover).
title: 0daynews.com news-writer scan-mode fallback 1 turn short — 36/35 failures still occurring post-fix
created: 2026-08-29
finding_class: turn-budget-scan-mode-undercount
dedupe_key: e822558829dbd483
scope: site
sites: [0daynews.com]
role: news-writer
window_from: 2026-08-23
window_to: 2026-08-29
measured_cost_usd: 7.5
estimated_savings_usd_per_day: 1.0
risk: low
verified_current_code: true
verified_git_check: "Read sites/0daynews.com/ops/scripts/run-news-writer.sh — line 63: `python3 ... --buffer 15 --fallback 35`. Read three post-window logs: 2026-08-25 (21/20), 2026-08-27 (31/30), 2026-08-29T00:00 (36/35), 2026-08-29T06:00 (36/35). Every failure hits exactly cap+1 turns. The 2026-08-27 commit raised the fallback from 30 to 35 but failures continue with the new ceiling. Hard cap is 40 per code comment at run-news-writer.sh:59."
evidence_files: ["sites/0daynews.com/ops/scripts/run-news-writer.sh:63", "sites/0daynews.com/ops/logs/news-writer-2026-08-29-0000.log:11", "sites/0daynews.com/ops/logs/news-writer-2026-08-29-0600.log:11"]
---

## Problem

`ops/scripts/run-news-writer.sh:63` sets the scan-mode turn fallback to 35:

```bash
COMPUTED_TURNS=$(... python3 turn_budget.py runtime news-writer --buffer 15 --fallback 35 ...)
```

Scan-mode (no queued task, backlog empty) is the dominant path for this role — 0daynews reacts to live CVE/breach feeds, not a pre-filed queue. Two sessions this morning (2026-08-29T00:00 and 2026-08-29T06:00) both hit:

```
claude-tracked.sh: FAILURE REASON — hit its turn cap (36/35)
```

This is the same cap+1 pattern documented in the code comment at lines 49–57 (where the previous buffer=8 produced cap+1 overruns). The 2026-08-27 commits raised the fallback from 30 to 35 but did not resolve the pattern — it simply moved the ceiling by 5. Historical failures match:
- 2026-08-25: 21/20 (old cap=20)
- 2026-08-27: 31/30 (cap=30 pre-fix)
- 2026-08-29 ×2: 36/35 (current cap=35)

The code comment at line 38–40 itself acknowledges: "the scan-mode budget itself needs separate investigation."

## Proposed change

In `sites/0daynews.com/ops/scripts/run-news-writer.sh:63`, raise `--fallback 35` to `--fallback 40`:

```bash
# before
COMPUTED_TURNS=$(... python3 "$TASK_BUDGET_SCRIPT" runtime news-writer --buffer 15 --fallback 35 2>/dev/null || echo 35)

# after
COMPUTED_TURNS=$(... python3 "$TASK_BUDGET_SCRIPT" runtime news-writer --buffer 15 --fallback 40 2>/dev/null || echo 40)
```

Also update the `|| echo 35` fallback to `|| echo 40` so the shell fallback matches.

The hard cap in turn_budget.py is 40 (per code comment at run-news-writer.sh:59), so this is the maximum the script will allow. No other file needs changing.

## Risk

Low — mechanical turn budget change. The 5 extra turns only cost something if a session actually uses them; a session that completes in 37 turns pays for 37. No behavioral change to what the role does or what it's allowed to read/write. The hard cap remains 40.

## Verification

Read `run-news-writer.sh` line 63 and confirmed current value is `--fallback 35`. Read three logs with grep for `error_max_turns`: 2026-08-29T00:00 (36/35), 2026-08-29T06:00 (36/35), 2026-08-27T00:00 (31/30 pre-fix), 2026-08-25T00:00 (21/20, older pre-fix era). Pattern is consistent across all windows — always cap+1. The code comment at lines 49–57 documents the same pattern from the previous buffer iteration.
