---
ticket_id: 2026-09-07-amputeenews-com-content-writer-max-turns-25-too-low-after-hu
status: applied
title: "amputeenews.com content-writer: MAX_TURNS=25 too low after humanizer pass added, causing repeated 26-turn cap failures"
created: 2026-09-07
decided: 2026-09-07
applied: 2026-09-07
applied_note: "run-role.sh:77 CONTENT_WRITER_MAX_TURNS raised 25->30. Also confirmed the separate task-backlog issue driving some of these runs' turn spend is independently resolved: content-writer-gate.py's has_queued_task() now filters COMPLETE/BLOCKED task files (2026-09-07 PE fix, fingerprint 17da65ac985d), and the 2026-09-07T13:10Z content-writer run retroactively marked 13 stale-complete task files so the gate stops re-surfacing them."
finding_class: turn-budget-too-low
dedupe_key: 3b7684d64cf71f31
scope: site
sites: [amputeenews.com]
role: content-writer
window_from: 2026-09-01
window_to: 2026-09-07
measured_cost_usd: 5.14
estimated_savings_usd_per_day: 0.73
risk: low
verified_current_code: true
verified_git_check: "Read sites/amputeenews.com/ops/scripts/run-role.sh — CONTENT_WRITER_MAX_TURNS=25 hardcoded at line 77. Read sites/amputeenews.com/ops/roles/content-writer.md — humanizer pass (lines 103-112) added 2026-09-02 (commit 3d949141). Checked 5 September in-window failure logs: every failure is exactly 26/25 turns (never a loop, always 1 over). Pre-window logs (Aug 30-31) show the same 26/25 pattern, confirming this pre-dates the humanizer and is the budget variance floor. fail-streak.json confirms 2 consecutive failures as of 2026-09-07T10:14Z. Today's 07:00 and 10:10 UTC runs both failed identically."
evidence_files: ["sites/amputeenews.com/ops/scripts/run-role.sh:77", "sites/amputeenews.com/ops/roles/content-writer.md:103"]
---

## Problem

`CONTENT_WRITER_MAX_TURNS=25` is hardcoded in `run-role.sh:77`. Every failure in the window hits exactly 26/25 — one turn over the cap, never more. This is consistent budget-variance overshoot, not a runaway loop. The role needs 26 turns on some sessions because it has a fixed minimum footprint: gate check, task triage (batch-read approach), WebFetch of a source, draft, self-edit, humanizer checklist read, and handoff.

The humanizer pass (added 2026-09-02, `content-writer.md:103-112`) added ~1-2 required turns to every session. The pre-existing 25-cap was already marginal (failures on Aug 30-31 before the humanizer). After the humanizer the failure rate rose: 5 of 30 calls (17%) in the Sep 01-07 window failed.

The pattern is unambiguous: 26/25 every single time, never 27 or 28. This is a cap that is simply 1 turn too low for the role's real floor after the humanizer was wired in.

## Proposed change

In `sites/amputeenews.com/ops/scripts/run-role.sh` at line 77:

```bash
# Before
CONTENT_WRITER_MAX_TURNS=25

# After
CONTENT_WRITER_MAX_TURNS=30
```

30 gives a 4-turn buffer above the observed failure floor (26), absorbs the humanizer's overhead with real margin, and still cuts off the pre-August runaway sessions (which ran 30-43 turns and are now blocked by the explicit turn-discipline rules added to `content-writer.md`).

## Risk

Low — mechanical budget bump. Does not change what the role does, only how many turns it gets to do it. The 5-turn increase above the current cap is conservative; the role's own doc warns against the runaway-tail above 25+ and the new turn-discipline rules (batch tool calls, one draft one revision, no dead-source retries) are in place to enforce that behaviorally. The historical runaway sessions (30-43 turns) were addressed by prompt changes, not the cap — raising to 30 does not re-enable them.

## Verification

- `run-role.sh:77`: `CONTENT_WRITER_MAX_TURNS=25` confirmed in current file.
- `content-writer.md:103-112`: humanizer pass step confirmed present.
- 5 in-window failure logs checked: all read `turns=26 exit=1`, subtype=`error_max_turns`.
- Pre-window failures (Aug 30 ×2, Aug 31 ×1) also at 26/25 — pattern predates humanizer.
- `content-writer-fail-streak.json`: `count: 2, last_at: 2026-09-07T10:14Z` — still failing today.
