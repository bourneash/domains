---
ticket_id: 2026-08-27-news-writer-scan-mode-budget-fallback-30-still-1-turn-short
status: proposed
title: news-writer scan-mode budget (--fallback 30) still 1 turn short post-fix — confirmed 31/30 failure after 2026-08-25 fix
created: 2026-08-27
finding_class: max-turns-scan-mode-fallback-undersize
dedupe_key: a2ab7cd55214673f
scope: site
sites: [0daynews.com]
role: news-writer
window_from: 2026-08-21
window_to: 2026-08-27
measured_cost_usd: 18.65
estimated_savings_usd_per_day: 0.65
risk: low
verified_current_code: true
verified_git_check: "Read run-news-writer.sh line 63: `--buffer 15 --fallback 30`. Checked ops/logs/news-writer-2026-08-27-0000.log: `turns=31 exit=1 subtype=error_max_turns cap=30` — confirmed scan-mode failure post-fix. Also checked news-writer-2026-08-25-0000.log (pre-fix): `turns=21 exit=1 cap=20` — same pattern, 1-turn overshoot, scan-mode. Pattern: fix raised fallback 20→30 but actual scan-mode session needs grew to 31. Backlog currently empty per CLAUDE.md ('0daynews reacts to live CVE/breach feeds, not a pre-filed queue') confirming these are scan-mode runs."
evidence_files: ["sites/0daynews.com/ops/scripts/run-news-writer.sh:63"]
---

## Problem

The 2026-08-25 fix (`7fde19d1`) raised `--buffer` from 8→15 for backlog-mode runs and `--fallback` from 20→30 for scan-mode runs. Scan-mode sessions (backlog empty) now run with MAX_TURNS=30. Post-fix log `news-writer-2026-08-27-0000.log` shows:

```
turns=31 exit=1 subtype=error_max_turns cap=30
```

The same 1-turn-overshoot pattern that was present before the fix: scan-mode is routinely exactly 1 turn over its cap. Pre-fix was 21/20; post-fix is 31/30. The fix moved the ceiling but not past the actual session length.

The script comment at line 38–44 explicitly flags this: "scan-mode budget itself needs separate investigation." That investigation is now done — the number is 31.

**Window impact:** 9 max_turns_failures out of 26 calls (34.6%), $6.96 wasted. The majority of this site's failures are scan-mode (acknowledged in code: 0daynews has an empty backlog most of the time, reacting to live CVE feeds).

## Proposed change

In `sites/0daynews.com/ops/scripts/run-news-writer.sh` line 63, change `--fallback 30` to `--fallback 35`:

```bash
# Before
COMPUTED_TURNS=$(cd "$REPO_ROOT" && python3 "$TASK_BUDGET_SCRIPT" runtime news-writer --buffer 15 --fallback 30 2>/dev/null || echo 30)

# After
COMPUTED_TURNS=$(cd "$REPO_ROOT" && python3 "$TASK_BUDGET_SCRIPT" runtime news-writer --buffer 15 --fallback 35 2>/dev/null || echo 35)
```

Also update the `echo 35` fallback on the same line. The turn_budget.py hard cap is 40 (unchanged), so 35 has 5 turns of margin and stays well below the ceiling.

## Risk

Mechanical, behaviour-preserving. Only scan-mode runs change (backlog empty → fallback used). A session that completes in 31 turns will now complete instead of dying. The hard cap at 40 remains in place. No change to backlog-mode budget.

## Verification

After deploy, the next scan-mode failure in ops/logs/news-writer-*.log should be absent or show turns well below 35. The max_turns_failures count in the weekly packet should drop.
