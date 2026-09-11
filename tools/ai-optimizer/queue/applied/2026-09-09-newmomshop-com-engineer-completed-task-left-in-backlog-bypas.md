---
ticket_id: 2026-09-09-newmomshop-com-engineer-completed-task-left-in-backlog-bypas
status: applied
title: "newmomshop.com engineer: completed task left in backlog/ bypasses gate, invoking Claude on every cron tick"
created: 2026-09-09
decided: 2026-09-10
applied: 2026-09-10
applied_commit: "9129958, ef4fe15 (sites/newmomshop.com); tools/cron-roles archetype hardened same-day in parent repo"
applied_note: "Option B (frontmatter-aware status:done exclusion) applied on newmomshop.com's ops/scripts/run-role.sh — verified already live (commits ef4fe15 + 9129958, current code reads only the YAML frontmatter block via awk before checking assigned_role/status, stricter than the ticket's proposed fix). Task file already moved to ops/tasks/done/. Additionally found and hardened the same unfiltered-grep pattern in the shared tools/cron-roles/archetypes/engineer/scripts/engineer-check.sh.tmpl (used by other fleet sites' engineer role) so status:done backlog tasks are excluded fleet-wide going forward, not just on newmomshop.com."
finding_class: completed-task-stuck-in-backlog-gate
dedupe_key: cb84be527f9098d8
scope: site
sites: [newmomshop.com]
role: engineer
window_from: 2026-09-03
window_to: 2026-09-09
measured_cost_usd: 15.6
estimated_savings_usd_per_day: 3.0
risk: low
verified_current_code: true
verified_git_check: "Read ops/tasks/backlog/2026-09-06-fix-performance-lcp-ms-performance-budgets.md: confirmed contains 'assigned_role: engineer' AND 'status: done' (completed 2026-09-06, commit a52e63f, never moved to done/). Read run-role.sh:188-190: grep -rl 'assigned_role: engineer' ops/tasks/backlog with no status filter — triggers BACKLOG_TASK=yes regardless of done status. Confirmed grep -l returns only this file (no active engineer tasks). Read logs/engineer-2026-09-09-0622.log and 0422.log: both show 'pre-check found work — invoking Claude' followed by Claude reporting nothing to fix (clean pass, commit already done, fleet-rollout task is human-triage)."
evidence_files: ["sites/newmomshop.com/ops/scripts/run-role.sh:188", sites/newmomshop.com/ops/tasks/backlog/2026-09-06-fix-performance-lcp-ms-performance-budgets.md]
---

## Problem

`ops/scripts/run-role.sh:188-190` decides whether to invoke Claude by grepping for `assigned_role: engineer` in `ops/tasks/backlog/` — but does not filter by `status:`:

```bash
if [[ -d "$REPO_ROOT/ops/tasks/backlog" ]] && grep -rl "assigned_role: engineer" "$REPO_ROOT/ops/tasks/backlog" >/dev/null 2>&1; then
  BACKLOG_TASK="yes"
fi
```

`ops/tasks/backlog/2026-09-06-fix-performance-lcp-ms-performance-budgets.md` has `assigned_role: engineer` and `status: done` (completed 2026-09-06, commit a52e63f). It was never moved to `done/`. On every engineer cron tick (every 30 min, 48/day), the grep finds this file, sets BACKLOG_TASK=yes, and invokes Claude. Claude then reads the task, sees it is already complete, and reports nothing to do.

Today's logs confirm this on every sampled run:
- `engineer-2026-09-09-0622.log`: "pre-check found work — invoking Claude" → Claude: "Nothing broken, nothing to fix."
- `engineer-2026-09-09-0422.log`: same — "pre-check found work — invoking Claude" → Claude: clean pass, task already done since 09-06.

With no genuine health or drift issues and no real backlog task, 100% of engineer Claude invocations since the task was filed are spurious. At $0.131/call × ~30 calls/day, this is ~$3.90/day in wasted spend.

## Proposed change

**Option A (immediate, lower risk):** Move `ops/tasks/backlog/2026-09-06-fix-performance-lcp-ms-performance-budgets.md` to `ops/tasks/done/`.

**Option B (systemic, prevents recurrence):** Update run-role.sh:188-190 to exclude status:done tasks from the gate:

```bash
BACKLOG_TASK=""
if [[ -d "$REPO_ROOT/ops/tasks/backlog" ]]; then
  if grep -rli "assigned_role: engineer" "$REPO_ROOT/ops/tasks/backlog" \
       | xargs grep -Ll "^status: done" 2>/dev/null \
       | grep -q .; then
    BACKLOG_TASK="yes"
  fi
fi
```

Option B handles any future task left in backlog/ after completion without manual cleanup.

## Risk

Low. Moving a file to done/ or adding a status filter to a grep is purely mechanical. The gate still triggers on real health failures, redirects drift, and genuine open tasks.

## Verification

After fix: engineer cron logs should show "clean pass (200, redirects in sync, no backlog) — skipped Claude entirely" on clean ticks. Confirm over 24 hours that Claude is not invoked when health=200 and no open tasks exist.
