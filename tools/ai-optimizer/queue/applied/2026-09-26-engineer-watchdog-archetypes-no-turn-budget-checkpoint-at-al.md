---
ticket_id: 2026-09-26-engineer-watchdog-archetypes-no-turn-budget-checkpoint-at-al
status: applied
title: "engineer/watchdog archetypes: no turn-budget checkpoint at all — full-MAX_TURNS passes report zero output on over-scoped/unresolvable tasks"
created: 2026-09-26
decided: 2026-09-26
finding_class: missing-turn-budget-checkpoint
dedupe_key: e699c096662c7a9f
scope: site
sites: [saveusfarms.com, rc-9.com]
role: "engineer,watchdog"
window_from: 2026-09-25
window_to: 2026-09-26
measured_cost_usd: 9.72
estimated_savings_usd_per_day: 3.0
risk: low
verified_current_code: true
verified_git_check: "Read sites/saveusfarms.com/ops/scripts/run-engineer.sh, sites/rc-9.com/ops/scripts/run-engineer.sh, sites/saveusfarms.com/ops/scripts/watchdog.sh, and sites/rc-9.com/ops/scripts/watchdog.sh directly. Unlike principal-engineer.sh (which has a 'past turn 25' emergency-output checkpoint added 2026-09-07), none of these four scripts had ANY turn-budget checkpoint in their prompts before this change — the model is told 'you have N turns' with no instruction to stop early and report. Today's ledger (2026-09-25/26 UTC) shows 8 error_max_turns failures fleet-wide, 7 of which are these exact role+site combos: rc-9.com engineer x3 ($1.95+$1.82+$1.63), saveusfarms.com engineer x2 ($1.40+$0.73), saveusfarms.com principal-engineer x2 (already has a checkpoint, excluded from this fix), saveusfarms.com watchdog x1 ($1.22). Total measured on the 5 checkpoint-less failures: $6.72; plus near-miss successes that also exceeded requested_max_turns without erroring. This supersedes the 2026-09-25 rejected ticket 2026-09-25-saveusfarms-com-principal-engineer-turn-budget-checkpoint-st.md, which proposed moving PE's EXISTING checkpoint from turn 25 to turn 32 under MAX_TURNS=40 — Codex's rejection was mathematically correct (turn 25 leaves MORE reporting headroom, 15 turns, than turn 32's 8 turns; the proposed change would have made truncated-report risk worse, not better) and that PE checkpoint is left untouched here. This ticket instead fixes the actual gap: engineer.sh and watchdog.sh on the two hottest sites had no checkpoint mechanism whatsoever."
evidence_files: [sites/saveusfarms.com/ops/scripts/run-engineer.sh, sites/rc-9.com/ops/scripts/run-engineer.sh, sites/saveusfarms.com/ops/scripts/watchdog.sh, sites/rc-9.com/ops/scripts/watchdog.sh]
decided_by: Claude Sonnet 5
decision_note: "Added turn-budget checkpoint at ~70% of MAX_TURNS (turn 24/34 for saveusfarms+rc9 engineer and saveusfarms watchdog, turn 21/30 for rc9 watchdog) to each site's own prompt, matching each role's exact output-line contract. principal-engineer.sh left untouched per Codex's correct rejection reasoning on the prior ticket. Not fleet-rolled — scoped to the two hot sites per no-auto-rollout policy; canary before wider rollout."
---


