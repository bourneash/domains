---
ticket_id: 2026-09-24-blackmarketapparel-com-principal-engineer-max-turns-40-too-l
status: rejected
title: "blackmarketapparel.com principal-engineer: MAX_TURNS=40 too low — 18% cap-failure rate wasting $15.73 in first 2 days"
created: 2026-09-24
decided: 2026-09-24
finding_class: max-turns-cap-too-low
dedupe_key: b791337327455d71
scope: site
sites: [blackmarketapparel.com]
role: principal-engineer
window_from: 2026-09-18
window_to: 2026-09-24
measured_cost_usd: 62.22
estimated_savings_usd_per_day: 7.87
risk: low
verified_current_code: true
verified_git_check: "Read sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh — MAX_TURNS=40 at line 32. Code comment at lines 23-31 documents the prior 30→40 bump on 2026-09-07 (same symptom: 3/14 = 21% failure rate at 30 turns). Turn-budget checkpoint in PROMPT (line ~267) tells the model to stop at turn 25 and report, but this is soft guidance only. 11/61 sessions still hit the hard ceiling at 40. retry_or_escalate (line 351) schedules a retry after 40 min for each cap failure, meaning every wasted session also generates a follow-on call — approximately doubling the real cost of each failure. Site was launched 2026-09-21 (commit 3294a6ef), active only 2 days in this window; launch-period incident rate may normalize, but the structural ceiling is code-visible and will affect any sustained PE dispatch load."
evidence_files: ["sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh:32"]
decision_note: "Root cause found and already fixed: 61 dispatches in 2 days were driven by non-actionable shared-auth Slack alerts re-fingerprinting as 'new' incidents each cooldown cycle (fleet auth outage the PE worker can never fix). Site's own PE self-hardened this today (commit 722912b, 'quarantine legacy auth incidents') — auth-owned incidents now marked resolved-noise instead of retried. Verified: zero PE dispatches and zero open/investigating incidents since the 12:49 ET fix landed. Raising MAX_TURNS 40->50 would have masked the real bug, not fixed it. Do not raise; re-measure after 48h to confirm the fix holds."
---

## Problem

The principal-engineer worker at `sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh:32` has `MAX_TURNS=40`. In 2 active days (the site launched 2026-09-21), 11 of 61 dispatches (18%) hit the hard turn cap and were abandoned. Each failure triggers `retry_or_escalate` (line 351), scheduling a follow-up call 40 minutes later — so every capped session also generates a retry, doubling its cost. Total wasted: $15.73 over 2 days = $7.87/day.

The same symptom was addressed fleet-wide on 2026-09-07 when 3/14 calls (21%) hit the 30-turn cap — the code comment at lines 23-31 documents this explicitly and explains the 30→40 bump. A turn-budget checkpoint was also added to the prompt at turn 25, but it is soft guidance; the model is still being cornered at turn 40 on complex incidents.

## Proposed change

Raise `MAX_TURNS` from `40` to `50` at `principal-engineer.sh:32`. This mirrors the pattern of the 2026-09-07 fix and gives the model the same class of headroom that resolved the prior fleet-wide failure burst. The `WORK_TIMEOUT=2400s` (40 min) provides ample wall-clock room for the additional turns.

## Risk

Low. This is a pure ceiling extension — no behavioral change for sessions that complete within 40 turns (the majority). No backlog implications: the PE processes at most one incident per cron tick, not a queue. The prior 30→40 bump was applied fleet-wide without incident.

## Verification

`principal-engineer.sh:32` confirmed `MAX_TURNS=40` in the current checkout. `retry_or_escalate` logic at line 351 confirmed that cap failures generate a retry call. Turn-budget checkpoint present at prompt lines ~263-271 but is soft/advisory only.
