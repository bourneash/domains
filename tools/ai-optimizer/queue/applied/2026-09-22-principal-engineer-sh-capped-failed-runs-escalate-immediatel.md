---
ticket_id: 2026-09-22-principal-engineer-sh-capped-failed-runs-escalate-immediatel
status: applied
title: "principal-engineer.sh: capped/failed runs escalate immediately without retry backoff on 37 of 38 sites"
created: 2026-09-22
decided: 2026-09-23
finding_class: retry-backoff-gap
dedupe_key: 409bf376a66ea1e3
scope: fleet
sites: [fleet]
role: principal-engineer
window_from: 2026-09-16
window_to: 2026-09-22
measured_cost_usd: 12.87
risk: medium
verified_current_code: true
verified_git_check: "blackmarketapparel.com commit c4095539 (2026-09-22) added a retry_or_escalate() helper wired to all 3 failure paths (timeout/124, non-zero exit incl. max-turns cap, missing result-contract) with a 40-min delayed retry and a 2-attempt ceiling before human-triage escalation, following the max-turns-35-too-low ticket. Grepped all 38 sites' principal-engineer.sh: retry_or_escalate() is defined in every site (fleet-wide helper already exists) but wired to only the timeout(124) path everywhere except blackmarketapparel.com -- the other 37 sites still call mark_incident open directly (no retry, immediate escalation) on the non-zero-exit and missing-contract paths, i.e. the exact paths a max-turns cap failure takes. This means a transient/near-cap failure escalates to Jesse on the first occurrence instead of getting one delayed retry, fleet-wide. Also found 2 script generations: 8 sites (blackmarketapparel, marineactivity, offshorehookup, reviewtattoo, saltwaternews, shoppinkflamingo, weirdassstuff, weirdgirlstore) have a PE_ROLLOUT_CANDIDATE result-contract gate; the other 30 do not enforce it at all. Structure has drifted enough (build-lock handling, git staging scope, commit-failure handling) that blind-copying blackmarketapparel's exact diff across all 37 is unsafe without per-site review."
evidence_files: ["sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh:362", "sites/aliencouncil.com/ops/scripts/principal-engineer.sh:226"]
decision_note: "Rolled out to all 30 remaining sites (9 were already fixed via blackmarketapparel.com's earlier fix). Added an explicit CLAUDE_EXIT!=0 guard right after the existing timeout(124) block in each site's principal-engineer.sh, routing through the existing retry_or_escalate() helper instead of falling through to the git-status/build-gate section with a defaulted escalated status. This also closes a correctness gap beyond the original escalation-noise finding: previously a capped/failed pass could still have its partial worktree committed+pushed, since the old code only special-cased exit==124 before reaching the commit path. All 30 sites are structurally identical templated copies so one mechanical patch applied cleanly to each; bash -n passed on all, existing test_principal_engineer_result_contract.test.sh and test_principal_engineer_scan.py both pass unchanged. Per-site commits + top-level pointer-bump commit 2196ebd8 pushed."
---


