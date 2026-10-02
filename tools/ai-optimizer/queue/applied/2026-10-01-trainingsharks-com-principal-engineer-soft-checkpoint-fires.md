---
ticket_id: 2026-10-01-trainingsharks-com-principal-engineer-soft-checkpoint-fires
status: applied
title: "trainingsharks.com principal-engineer: soft checkpoint fires at turn 32 (MAX_TURNS-8) — sessions consistently hit hard cap with 0-byte result files"
created: 2026-10-01
decided: 2026-10-01
finding_class: soft-checkpoint-too-late
dedupe_key: ac4d0c0a37d3ef66
scope: site
sites: [trainingsharks.com]
role: principal-engineer
window_from: 2026-09-25
window_to: 2026-10-01
measured_cost_usd: 6.25
estimated_savings_usd_per_day: 0.5
risk: low
verified_current_code: true
verified_git_check: "Confirmed MAX_TURNS=40 at principal-engineer.sh:32 and CHECKPOINT_TURN=$((MAX_TURNS - 8))=32 at principal-engineer.sh:36. Read ops/logs/principal-engineer-20260928.log: two entries explicitly show 'hit its turn cap (41/40)' on fp=b3e206ccd44d attempts 1 and 3. Read ops/health/principal-incidents/ archive: partial.txt files for all 4 max_turns failures are 0 bytes, confirming sessions hit the cap without producing any text output. The two commits in window (5844f8d4, 214f104a) touch worker-launch counting and wrapper state — neither modifies MAX_TURNS or CHECKPOINT_TURN. The current code at principal-engineer.sh:36 is unchanged from before the window's commits."
evidence_files: ["sites/trainingsharks.com/ops/scripts/principal-engineer.sh:32", "sites/trainingsharks.com/ops/scripts/principal-engineer.sh:36"]
decision_note: "sites/trainingsharks.com/ops/scripts/principal-engineer.sh:36 CHECKPOINT_TURN=MAX_TURNS-15 (commit 7090d06)"
---

## Problem

4 of 5 principal-engineer calls in the window (80%) hit the 40-turn hard cap and exited rc=1 (error_max_turns), wasting $5.12 of $6.25 total spend. All four result files in ops/health/principal-incidents/ are 0 bytes — sessions ended with a tool call as their last action, never producing the required PE_STATUS/PE_ROOT_CAUSE/PE_FIX/PE_HARDENING/PE_ROLLOUT_CANDIDATE block. Both active incidents (fp=2c0ffde67b7c, fp=b3e206ccd44d) exhausted all 3 attempts and escalated to human triage without a completed result.

ops/logs/principal-engineer-20260928.log explicitly shows for fp=b3e206ccd44d:
```
clauded-tracked.sh: FAILURE REASON — hit its turn cap (41/40)
```
on both attempt 1 and attempt 3.

The soft checkpoint at `principal-engineer.sh:36` is `CHECKPOINT_TURN=$((MAX_TURNS - 8))` = turn 32. The PROMPT injects this as: "If you are past turn 32, do not start another investigation or tool call. STOP and output the final report block immediately." With only 8 turns remaining when the instruction fires, the model is reliably mid-investigation and decides to finish the current fix before reporting — overshooting the cap in the process. The 0-byte result files confirm the model never got around to the text report.

## Proposed change

`sites/trainingsharks.com/ops/scripts/principal-engineer.sh`, line 36:

```bash
# Before:
CHECKPOINT_TURN=$((MAX_TURNS - 8))

# After:
CHECKPOINT_TURN=$((MAX_TURNS - 15))
```

This moves the soft checkpoint from turn 32 to turn 25. With 15 turns remaining when the instruction fires (vs 8), the model has real margin to wrap up gracefully and produce the report block rather than trying to squeeze one more fix into a narrowing budget and overshooting. The checkpoint instruction in the PROMPT is already well-written; the problem is purely that 8 turns of reserve is insufficient for complex engineering incidents.

## Risk

Low. MAX_TURNS is unchanged at 40. The model still has 25 full turns for investigation before the checkpoint fires. The only behavioral change: 'stop and report' arrives 7 turns earlier. In the worst case (model still ignores the checkpoint), behavior is identical to today. In the best case, the margin is wide enough that the model follows the instruction and produces a partial-but-useful report even on hard incidents, converting wasted sessions into escalations with diagnostic content.

## Verification

Read principal-engineer.sh lines 32 and 36 directly. Read ops/logs/principal-engineer-20260928.log confirming two explicit 'hit its turn cap (41/40)' events on fp=b3e206ccd44d. Read all partial.txt archives in ops/health/principal-incidents/ — all 0 bytes on max_turns failures. Read incident JSON files (2c0ffde67b7c.json, b3e206ccd44d.json) confirming both exhausted 3 attempts with last_outcome='pass FAILED (rc=1) before a complete result'. Verified commits 5844f8d4 and 214f104a (the two in-window commits) touch principal-engineer-scan.py dispatch logic and wrapper state — neither changes MAX_TURNS or CHECKPOINT_TURN.
