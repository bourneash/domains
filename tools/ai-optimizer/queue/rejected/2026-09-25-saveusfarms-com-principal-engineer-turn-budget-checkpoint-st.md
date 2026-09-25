---
ticket_id: 2026-09-25-saveusfarms-com-principal-engineer-turn-budget-checkpoint-st
status: rejected
title: saveusfarms.com principal-engineer turn-budget checkpoint stale after MAX_TURNS raised to 40
created: 2026-09-25
decided: 2026-09-25
finding_class: stale-turn-budget-checkpoint
dedupe_key: 2d42eb3cd45ff077
scope: site
sites: [saveusfarms.com]
role: principal-engineer
window_from: 2026-09-19
window_to: 2026-09-25
measured_cost_usd: 11.51
estimated_savings_usd_per_day: 0.68
risk: low
verified_current_code: true
verified_git_check: "Read sites/saveusfarms.com/ops/scripts/principal-engineer.sh directly. Line 33 sets MAX_TURNS=40. Line 311 of the PROMPT still says 'If you are past turn 25 and have not yet output your final report block, STOP investigating/fixing/hardening right now and output that block immediately' — the checkpoint threshold was never updated when MAX_TURNS was raised from 30 to 40. The 3 failed passes for incident e8801ec4f5a9 (2026-09-24 22:01 ET, 22:56 ET, and a 3rd) all hit 41/40 turns; both archived partial files are 0 bytes, confirming the model ran all 40 turns in tool calls and never reached the text-output stage. The checkpoint at turn 25 left 15 turns of perceived budget remaining, so the model continued investigating instead of producing emergency output."
evidence_files: ["sites/saveusfarms.com/ops/scripts/principal-engineer.sh:33", "sites/saveusfarms.com/ops/scripts/principal-engineer.sh:311"]
decided_by: Codex (user-requested triage)
decision_note: "Causal claim is incorrect: turn 25 is earlier than turn 32 and already leaves 15 turns of reserve under MAX_TURNS=40. Raising the checkpoint reduces reporting headroom and cannot prevent a model that ignored the existing instruction from hitting the cap. The actual triggering live article 404 was repaired separately; https://saveusfarms.com/articles/2026-09-25-federal-permitting-reform-data-centers-farmland/ now returns 200 (2026-09-25 07:53 ET). No PE prompt change applied."
---

## Problem

`principal-engineer.sh:33` sets `MAX_TURNS=40`. `principal-engineer.sh:311` contains the emergency output checkpoint: *"If you are past turn 25 and have not yet output your final report block, STOP…"*

This checkpoint was added on 2026-09-07 when MAX_TURNS was 30. At 30 turns, "past turn 25" fires at 83% of budget — a narrow safety margin. When MAX_TURNS was subsequently raised to 40, the threshold was not updated. At 40 turns, "past turn 25" fires at only 62.5% of budget. The model sees 15 remaining turns and keeps investigating.

Result: incident `e8801ec4f5a9` (live smoke failure, first seen 2026-09-25T02:01) consumed all 3 dispatch attempts, each hitting 41/40 turns, each producing 0 bytes of output. Both archived partial files (`e8801ec4f5a9-20260925T021305Z.partial.txt` and `e8801ec4f5a9-20260925T030254Z.partial.txt`) are exactly 0 bytes. The model burned 3 × $1.58 = $4.75 doing tool-call investigation that never reached a text response. The incident escalated to human with zero diagnostic content from any of the three attempts.

## Proposed change

In `sites/saveusfarms.com/ops/scripts/principal-engineer.sh` line 311, update the checkpoint threshold from 25 to 32 (80% of MAX_TURNS=40):

```
# Before
If you are past turn 25 and have not yet output your final report block, STOP

# After  
If you are past turn 32 and have not yet output your final report block, STOP
```

This gives the model 32 turns to investigate/fix, then requires it to produce output in the remaining 8 turns — enough to write a `PE_STATUS` / `PE_ROOT_CAUSE` block even from a partial investigation.

## Risk

Low. This is a prompt text change to a numeric constant. Same logic, better calibrated threshold. The model is not asked to do less — it is asked to report what it found at turn 32 instead of silently burning all 40. For incidents resolvable in under 32 turns (the majority), this change has no effect.

## Verification

Confirmed: `principal-engineer.sh:33` = `MAX_TURNS=40`, `principal-engineer.sh:311` = "past turn 25". Incident `e8801ec4f5a9` archived partials confirmed 0 bytes (2026-09-25). 3/10 principal-engineer calls in window hit max_turns; all 3 on this incident class.
