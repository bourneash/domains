---
ticket_id: 2026-08-25-voice-auditor-costs-1-05-call-5-full-rewrites-per-run
status: rejected
title: voice-auditor costs ~$1.05/call — 5 full rewrites per run
created: 2026-08-25
decided: 2026-08-25
finding_class: rewrite-scope-cost
dedupe_key: b644e751ae31198e
scope: site
sites: [sinderella.org]
role: voice-auditor
window_from: 2026-08-11
window_to: 2026-08-25
measured_cost_usd: 29.38
estimated_savings_usd_per_day: 0.8
risk: medium
verified_current_code: true
verified_git_check: git log -3 ops/roles/voice-auditor.md — last tuned cc470e57 (2026-08-23, cap 40->70). Cost continued AFTER that commit ($0.98/$1.19/$1.06 on 08-24..25), so this is current behaviour, not pre-fix telemetry.
evidence_files: [sites/sinderella.org/ops/roles/voice-auditor.md:40, sites/sinderella.org/ops/scripts/run-role.sh:501]
decided_by: dashboard
---

## Problem

voice-auditor averages ~$1.05/call, 45-57 turns/run — the most expensive per-call role in the fleet. This is NOT a defect: the role samples up to 20 files and does up to 5 full in-place rewrites per run (~11 turns each), and a cheap pre-gate already skips runs with 0 pending files. The 2026-08-23 commit raised the turn cap to 70 precisely to let a 5-rewrite batch finish.

## Why it is still worth a decision

Cost is a direct function of the 5-rewrites-per-run scope in voice-auditor.md step 7. Nothing is broken; the question is whether that scope is worth ~$2/day.

## Proposed change

Reduce the per-run rewrite budget from 5 to 3. Backlogged pieces are picked up on the next run (the role is scheduled, and the pre-gate already tracks pending files), so nothing is dropped — it just drains slower.

## Risk — why this is NOT auto-appliable

This trades voice-audit throughput for cost. If pending files arrive faster than 3/run, the quarantine backlog grows and sub-threshold content sits unfixed longer. Needs a human call on the tradeoff, and if approved, watch the pending count for a week.

## Verification

After change: pending-file count from run-role.sh's pre-gate should stay flat run-over-run, not climb.
