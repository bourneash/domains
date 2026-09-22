---
ticket_id: 2026-09-22-blackmarketapparel-com-principal-engineer-max-turns-35-too-l
status: applied
title: "blackmarketapparel.com principal-engineer: MAX_TURNS 35 too low, capped runs retry at full cost"
created: 2026-09-22
decided: 2026-09-22
finding_class: max-turns-underbudget
dedupe_key: 34f77511b8ae1614
scope: site
sites: [blackmarketapparel.com]
role: principal-engineer
window_from: 2026-09-16
window_to: 2026-09-22
measured_cost_usd: 12.87
estimated_savings_usd_per_day: 1.5
risk: low
verified_current_code: true
verified_git_check: "Read sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh in full. Line 32: MAX_TURNS=35. Lines 362-366: CLAUDE_EXIT != 0 path calls mark_incident open (not escalated), meaning every capped run burns 35 turns and the incident is re-queued for up to 3 total retries — worst case 105 turns for an incident that needs 36. Lines 23-32 document the prior 30→35 raise after the same failure pattern on 2026-09-07 (3/14 fleet PE calls capped). Fleet default in run-role.sh is 40 turns."
evidence_files: ["sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh:32", "sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh:362"]
decision_note: "Applied by an autonomous principal-engineer run (commits 3237aa6/c409553) same day: MAX_TURNS 35->40 + retry-or-escalate backoff wired to all failure paths on blackmarketapparel.com. Also rolled MAX_TURNS 35->40 fleet-wide to 37 other sites (top-level 8554da66) since the same cap-then-full-cost-retry pattern applies fleet-wide. Retry/backoff logic wiring NOT replicated fleet-wide — principal-engineer.sh has diverged into 2 generations (8 sites w/ result-contract gate, 31 without) with per-site drift in build-lock/staging/commit-failure handling; blind-patching risks regressions. Filing separate ticket for that."
---

## Problem

`principal-engineer.sh:32` sets `MAX_TURNS=35`. In this window, 9 of 57 calls (15.8%) hit the cap, wasting $12.87 on the site's first active day (2026-09-21).

The failure path is unforgiving: `principal-engineer.sh:362-366` handles any non-zero `CLAUDE_EXIT` (including max_turns) by calling `mark_incident open`, archiving the partial result, and exiting 1. The incident goes back to the retry queue. An investigation that legitimately needs 36 turns can burn 3×35=105 turns across three failed attempts before escalating to Jesse with zero diagnostic output — the exact outcome the 30→35 raise was meant to prevent (see comment at line 23-32).

## Proposed change

Raise `MAX_TURNS` from 35 to 40 in `sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh:32`.

40 is the fleet default (run-role.sh fallthrough). The 30→35 raise history in the file's own comments shows this pattern repeats: a complex incident class exceeds the cap, the cap gets bumped by 5. Going to 40 now mirrors the existing fleet-wide baseline and leaves room for the same turn-budget checkpoint logic already in the prompt (lines 264+) to report findings before running out.

## Risk

Low. This is the same mechanical headroom increase that fixed the 30→35 problem. The investigation scope doesn't change, the prompt doesn't change, the gating (build check, git push, PE_STATUS contract) doesn't change. Runs that fit in 35 turns are unaffected. Runs that currently cap at 35 and get retried may now complete on the first attempt, reducing both waste and retry load.

## Verification

- `principal-engineer.sh:32` — `MAX_TURNS=35` confirmed in live file
- `principal-engineer.sh:362-366` — non-zero exit → `mark_incident open` confirmed (retry path)
- `principal-engineer.sh:23-32` — prior 30→35 raise documented with identical rationale
- Fleet default: `run-role.sh` fallthrough uses `MAX_TURNS=40`
- 9 max_turns_failures × $1.43/failure = $12.87 in 1 active day confirmed from packet
