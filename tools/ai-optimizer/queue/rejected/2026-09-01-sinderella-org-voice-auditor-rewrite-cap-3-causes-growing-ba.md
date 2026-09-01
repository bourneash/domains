---
ticket_id: 2026-09-01-sinderella-org-voice-auditor-rewrite-cap-3-causes-growing-ba
status: rejected
title: "sinderella.org voice-auditor: rewrite cap 3 causes growing backlog — role doc says raise back to 5"
created: 2026-09-01
decided: 2026-09-01
finding_class: throughput-cap-too-low
dedupe_key: 73c6249f9026b85b
scope: site
sites: [sinderella.org]
role: voice-auditor
window_from: 2026-08-26
window_to: 2026-09-01
measured_cost_usd: 13.43
estimated_savings_usd_per_day: -0.46
risk: low
verified_current_code: true
verified_git_check: "Read ops/roles/voice-auditor.md:74 — cap confirmed at 3 with parenthetical (lowered from 5 on 2026-08-29). Read ops/scripts/run-role.sh:501 — MAX_TURNS=70, set for the 5-rewrite cap and unchanged since the cap reduction. Read ops/board/voice-drift.md 2026-08-31 16:00 UTC entry: 20 sampled, 3 passed, 3 rewritten (cap hit every run), 12 deferred. Bash grep count 2026-09-01: 109 files with voice_score:pending. Packet commit a3098d97 before/after: $6.65/6 calls ($1.108/call) vs $6.78/6 calls ($1.130/call) — no material cost change from cap reduction. Reading-generator confirmed in CLAUDE.md to produce 12 horoscopes/day."
evidence_files: ["sites/sinderella.org/ops/roles/voice-auditor.md:74", sites/sinderella.org/ops/board/voice-drift.md, "sites/sinderella.org/ops/scripts/run-role.sh:501"]
decision_note: "Premise disproved 2026-09-01. The ticket argues the rewrite cap of 3 causes a backlog growing +6/day and cites 109 pending files. Measured from git history of 'voice_score: pending' across site/src/content: 103 (08-26), 97 (08-28), 91 (08-30), 98 (09-01). Flat-to-declining, oscillating ~90-100. At the claimed +6/day it would be ~145 by now. The compounding-backlog argument, and the deployer-deadlock risk built on top of it, do not hold. The ticket's own cost measurement already showed the 5->3 cap change produced no material saving ($1.108 vs $1.130/call), so raising it back would add cost to fix a problem that is not occurring. Re-file if the pending count breaks above ~120 and keeps climbing."
---

## Problem

The voice-auditor rewrite cap was lowered 5->3 on 2026-08-29 (commit a3098d97) expecting ~40% cost reduction. Measured before/after shows no material cost change: $1.108/call before, $1.130/call after. The base session cost (loading voice bible + SKILL.md, running voice-pregate.py over 20 files, committing) dominates; incremental rewrite cost is small.

Meanwhile the throughput cut is real and compounding. reading-generator produces 12 new voice_score:pending files/day (one per sign). The auditor scores 20 per pass x 2 passes/day, but only ~3 files pass scoring (cleared from pending) per pass. The 3 rewritten go back to pending — they do not clear the backlog. Net clearing rate: 6/day. Net growth: 12 new minus 6 cleared = +6 pending/day. Current backlog: 109 files as of 2026-09-01.

The 2026-08-31 16:00 UTC audit entry confirms the cap is hit every run: 20 sampled, 3 passed, 3 rewritten (cap hit), 12 deferred. ops/roles/voice-auditor.md step 7 explicitly anticipates this: 'if quarantine/pending volume climbs instead of clearing, the cap came down too far and should go back toward 5, not lower again.' That condition is now met.

Risk of not fixing: the deployer enforces a 24h voice-drift rule. If the growing pending backlog causes unscored content to block deploys, all deploys stop indefinitely — exactly the 2026-06-13 incident.

## Proposed change

In sites/sinderella.org/ops/roles/voice-auditor.md:74, change 'rewrite at most 3 sub-threshold pieces per run (lowered from 5 on 2026-08-29...)' back to 'rewrite at most 5 sub-threshold pieces per run'. Update the parenthetical and cost-discipline section to reflect that the 5->3 change produced no measurable cost saving but did degrade throughput.

run-role.sh:501 sets MAX_TURNS=70 — that was set for the 5-rewrite cap ('~11 turns each observed in practice'). No change needed there.

## Risk

Low. Reverses a change that had no measurable cost effect. Expected cost impact: approximately +$0.46/day on runs that hit the full 5-rewrite cap (current $2.24/day worst-case -> ~$2.70/day). Most sessions won't hit 5-cap once the backlog clears. Counterfactual risk is the deployer deadlock (high severity — stops all deploys until manually cleared, per 2026-06-13 incident).

## Verification

ops/roles/voice-auditor.md:74: cap confirmed at 3 in live code. ops/scripts/run-role.sh:501: MAX_TURNS=70, already set for 5-rewrite cap. ops/board/voice-drift.md 2026-08-31 16:00 entry: cap hit every run, 12 deferred per pass. Bash grep 2026-09-01: 109 files voice_score:pending. Packet commit a3098d97 before/after: $1.108 -> $1.130/call — no cost change from cap reduction. Role doc step 7 explicitly says to raise the cap if this condition is met.
