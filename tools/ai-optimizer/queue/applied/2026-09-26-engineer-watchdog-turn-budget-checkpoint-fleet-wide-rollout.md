---
ticket_id: 2026-09-26-engineer-watchdog-turn-budget-checkpoint-fleet-wide-rollout
status: applied
title: "engineer/watchdog turn-budget checkpoint: fleet-wide rollout (was scoped to rc-9.com/saveusfarms.com only)"
created: 2026-09-26
decided: 2026-09-26
finding_class: missing-turn-budget-checkpoint
dedupe_key: a32cbb93be40c4b3
scope: fleet
role: "engineer,watchdog"
window_from: 2026-09-25
window_to: 2026-09-26
measured_cost_usd: 9.72
estimated_savings_usd_per_day: 3.0
risk: low
verified_current_code: true
verified_git_check: "Explicit user instruction ('please implement it in full') to widen the 2026-09-26 two-site fix (ticket 2026-09-26-engineer-watchdog-archetypes-no-turn-budget-checkpoint-at-al.md) fleet-wide. Discovered mid-rollout that 6 sites (blackmarketapparel.com, girlpain.com, howfishthink.com, marineactivity.com, saltwaternews.com, searchwoot.com) already carried an identical checkpoint on watchdog.sh only, dated '2026-09-10 fix', using a dynamic $((MAX_TURNS - 8)) formula rather than a hardcoded turn number -- this avoids exactly the staleness bug (checkpoint number not updated when MAX_TURNS is bumped) that caused the original 2026-09-25 ticket to be correctly rejected. Re-did the rc-9.com/saveusfarms.com edits to match this established dynamic-formula convention for consistency, then applied it via script to every remaining site: 33 run-engineer.sh files and 30 watchdog.sh files (the 2 already-fixed sites, the 6 pre-existing watchdog.sh sites, and 2 sites whose engineer.sh is zero-Claude-turn bash-only -- allthingsmasonic.com, amputeenews.com -- were skipped). principal-engineer.sh left untouched everywhere per the standing, correct rejection reasoning on the prior ticket (moving its existing turn-25 checkpoint would reduce reporting headroom, not increase it). Verified: grep -rl 'Turn-budget checkpoint' sites/*/ops/scripts/{run-engineer.sh,watchdog.sh} now returns 73 files (35 engineer + 38 watchdog, all sites that invoke claude -p from these two roles); bash -n syntax-checked every touched file, all pass; MAX_TURNS ranges from 30 (watchdog default) to 40 (sinderella.org engineer), so MAX_TURNS-8 stays well clear of both 0 and the cap fleet-wide."
evidence_files: [sites/0daynews.com/ops/scripts/run-engineer.sh, sites/0daynews.com/ops/scripts/watchdog.sh, sites/sinderella.org/ops/scripts/run-engineer.sh]
decided_by: Claude Sonnet 5
decision_note: Rolled out to all 35 engineer.sh + all 38 watchdog.sh files fleet-wide (see verified_git_check for exact counts/skips). Standardized rc-9.com/saveusfarms.com onto the pre-existing dynamic MAX_TURNS-8 formula for consistency.
---


