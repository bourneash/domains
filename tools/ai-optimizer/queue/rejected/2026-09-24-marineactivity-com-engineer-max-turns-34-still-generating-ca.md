---
ticket_id: 2026-09-24-marineactivity-com-engineer-max-turns-34-still-generating-ca
status: rejected
title: "marineactivity.com engineer: MAX_TURNS=34 still generating cap failures after two prior bumps"
created: 2026-09-24
decided: 2026-09-24
finding_class: max-turns-cap-too-low
dedupe_key: 0586c0efc2a943e8
scope: site
sites: [marineactivity.com]
role: engineer
window_from: 2026-09-18
window_to: 2026-09-24
measured_cost_usd: 8.27
estimated_savings_usd_per_day: 0.51
risk: low
verified_current_code: true
verified_git_check: "Read sites/marineactivity.com/ops/scripts/run-engineer.sh — MAX_TURNS=34 at line 20. Git log shows two prior bumps for the same symptom: commit 79d2ede (2026-09-10) raised 25→29 with subject 'raise MAX_TURNS 25->29 (error_max_turns audit)', and commit adc27a1 (2026-09-14) raised again with subject 'fix: bump engineer role MAX_TURNS headroom (turn-cap failures in 24h audit)'. This window recorded a third max_turns failure ($1.53 wasted) — 1 out of 9 calls (11%) — indicating the ceiling has not been raised enough to contain the role's actual task complexity."
evidence_files: ["sites/marineactivity.com/ops/scripts/run-engineer.sh:20"]
decision_note: "Third blind bump for the same symptom (25->29->34, now proposed 34->40) without checking WHY. This window: only 1/9 calls (11%) capped — not the chronic pattern the title implies; site is green, backlog is 6 items, queue=0. Also found a real anomaly worth investigating instead: multiple 'success' calls across the fleet logged num_turns exceeding requested_max_turns (marineactivity engineer 41>34, saveusfarms.com principal-engineer 51>40, saveusfarms.com watchdog 52>30) -- suggests MAX_TURNS enforcement/logging may not be reliable, which would explain why raising the number has never converged. Investigate cap enforcement before touching the number a third time."
---

## Problem

`run-engineer.sh:20` sets `MAX_TURNS=34`. The git log records two prior bumps for the identical symptom: 25→29 on 2026-09-10 and 29→34 on 2026-09-14. A third cap failure occurred in this window (1/9 calls = 11%, $1.53 wasted). The ceiling is not converging on a value that contains this site's task complexity.

## Proposed change

Raise `MAX_TURNS` to `40` at `run-engineer.sh:20`. The prior increments of +4 and +5 have been insufficient; a larger jump to the fleet default (40) is more likely to stop the pattern from recurring.

## Risk

Low. The same class of change applied twice already without incident. Engineer has a work-lock (one pass at a time) and a network preflight gate — raising the ceiling does not affect how often it fires or its queue.

## Verification

`run-engineer.sh:20` confirmed `MAX_TURNS=34` in the current checkout. Git log confirms the two prior bumps (79d2ede, adc27a1) and the recurring nature of the failure.
