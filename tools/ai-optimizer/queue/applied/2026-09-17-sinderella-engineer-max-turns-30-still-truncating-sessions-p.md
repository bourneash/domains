---
ticket_id: 2026-09-17-sinderella-engineer-max-turns-30-still-truncating-sessions-p
status: applied
title: "sinderella engineer: MAX_TURNS=30 still truncating sessions post-fix (25→30 bump insufficient)"
created: 2026-09-17
decided: 2026-09-17
finding_class: max-turns-too-low
dedupe_key: 3191c81e3f504b2e
scope: site
sites: [sinderella.org]
role: engineer
window_from: 2026-09-11
window_to: 2026-09-17
measured_cost_usd: 3.56
estimated_savings_usd_per_day: 0.51
risk: medium
verified_current_code: true
verified_git_check: "git diff 6e106a0b on sites/sinderella.org confirmed the prior fix changed MAX_TURNS from 25 to 30 (ops/scripts/run-engineer.sh:17). Current value is 30. Board log at ops/board/engineer-log.md shows 3 runs with generic 'engineer run complete' summary across the window — that output is only produced when grep cannot find ENGINEER_SUMMARY= in the result file, which happens when Claude exits via max_turns before printing the structured output lines. Sep 16 shows the pattern explicitly: generic (14:42) → generic (15:14) → successful deploy of voice-regex-audit.mjs fix (15:39), confirming the same task needed 3 attempts. 2 pre-fix calls (Sep 12-13), 7 post-fix calls (Sep 14-17); 1 pre-fix failure (Sep 13), 2 post-fix failures (Sep 16 × 2)."
evidence_files: ["sites/sinderella.org/ops/scripts/run-engineer.sh:17"]
decision_note: "Applied: sites/sinderella.org/ops/scripts/run-engineer.sh:17"
---

## Problem

The 2026-09-14 fix bumped MAX_TURNS from 25 → 30 to address turn-cap failures. It helped but didn't fully solve the problem: 2 of the 7 post-fix calls still hit the cap and produced no output (Sep 16 at 14:42 and 15:14), together wasting $2.37. The Sep 16 pattern is decisive — two truncated passes followed immediately by a third that successfully deployed the same voice-regex-audit.mjs fix — confirming the task needed more than 30 turns to complete, not a different kind of failure.

Current code: `ops/scripts/run-engineer.sh:17` — `MAX_TURNS=30`.

## Proposed change

Raise `MAX_TURNS` from 30 to 40 in `ops/scripts/run-engineer.sh:17`.

The failing sessions took roughly 1500–1800 s to hit 30 turns (inferred from Sep 16 gap between attempts), implying ~50–60 s/turn average. At that rate, 40 turns ≈ 2000–2400 s — within or just touching the existing `WORK_TIMEOUT=2400`. Given that successful sessions with similar task complexity complete well under 2400 s, 40 turns should not trigger the wall-clock timeout. If post-change sessions begin hitting the 2400 s limit instead of max_turns, `WORK_TIMEOUT` can be revisited as a follow-on.

## Risk

Medium. Sessions that previously failed at 30 turns will now run longer and complete — slight cost increase per session (~$0.15–0.30 extra on completion) offset against eliminating the full session cost on failure. Does not change gating, commit, or deploy behaviour; only the turn cap on the model work pass.

## Verification

Read `ops/scripts/run-engineer.sh:17`: `MAX_TURNS=30` confirmed. `git show 6e106a0b -- ops/scripts/run-engineer.sh | grep MAX_TURNS` shows `-MAX_TURNS=25 / +MAX_TURNS=30` — the prior fix. Board log shows 3 generic-summary ('engineer run complete') entries in window: Sep 13 (pre-fix), Sep 16 14:42 and 15:14 (post-fix). Sep 16 15:39 entry ('Fixed voice-regex-audit.mjs ... deployed') confirms the same task completed on the third attempt.
