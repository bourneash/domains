# Paperclip evaluation and Fleet Executive decision

Updated: 2026-09-27

## Decision

Do not replace Fleet Executive with Paperclip. Adopt Paperclip's control-plane
ideas inside the existing fleet system and keep the current fleet-specific
execution plane.

Paperclip is a strong general-purpose coordinator for autonomous-agent
companies: it provides company-scoped goals, org charts, issues, heartbeats,
budgets, approvals, workspaces, adapters, activity logs, and bounded recovery.
The project describes itself as a control plane rather than an agent framework
or code-review tool: <https://github.com/paperclipai/paperclip>.

Fleet Executive already owns the parts that matter most to this portfolio and
that a generic harness cannot safely replace: site discovery and exclusion,
read-only intelligence, attribution boundaries, compliance/legal/security
gates, isolated site worktrees, Cloudflare-build-only release policy,
measurement closure, and the existing CEO/CFO/CTO/Legal/Security handoff
sequence. Switching would duplicate or weaken those controls before proving
that Paperclip can preserve them.

## Capability comparison

| Capability | Paperclip | Fleet Executive | Decision |
| --- | --- | --- | --- |
| Agent org chart and role contracts | First-class | Role-specific executive and site-worker contracts | Keep fleet roles; borrow explicit reporting/ownership language |
| Goal ancestry | Company/project/goal/parent issue model | Proposals, work items, workflow links, scorecards | Add goal ancestry incrementally; do not migrate the control plane |
| Durable work and communication | Issues, comments, documents, work products | Work items, proposals, messages, handoffs, artifacts/evidence | Keep fleet model; preserve inspectable evidence |
| Heartbeats and leases | Scheduled/event wakes, atomic checkout, run state | Scheduler, single-flight locks, leases, heartbeats, queue retries | Keep fleet scheduler; add liveness diagnostics |
| Budgets and cost controls | Agent/company budgets and hard stops | AI usage ledger, queue caps, model-run limits, scorecard | Keep fleet accounting; map provider costs before any migration |
| Approvals/governance | Board approvals and policies | Owner approval plus Legal/Security gates and release pipeline | Fleet is stricter for this portfolio; retain it |
| Workspaces/runtime | Git worktrees and runtime services | Isolated worktrees, sandboxed workers, preview/validation gates | Keep fleet implementation |
| Multi-company isolation | First-class companies | One fleet with explicit site exclusion and shared evidence | Paperclip is stronger here, but portfolio sites are not independent companies |
| Recovery | Explicit recovery actions and watchdog semantics | Failure follow-ups, queue recovery, workflow diagnostics | Adopt the “healthy wait vs stranded work” distinction |
| Extensibility | Adapters/plugins/MCP gateway | Fixed trusted action registry and bounded providers | Keep fixed registry for safety; consider an adapter boundary later |

## Changes made

`tools/fleet-dashboard/server/executive-liveness.js` adds a deterministic,
read-only liveness audit. It reports an expired active lease or a waiting/
blocked work item with no durable owner, dependency, retry, or waiting target.
It produces a stable recovery key for deduplication, but never requeues work,
changes ownership, or bypasses approval. The result is available at
`GET /api/executive/liveness` and is covered by
`tools/fleet-dashboard/server/executive-liveness.test.js`.

This is intentionally a control-plane improvement rather than a Paperclip
dependency. It prevents a common autonomous-agent failure mode: treating a
status label, comment, or stale process as proof that work is still covered.

The executive store now also has a backward-compatible goal hierarchy and
work lineage contract: `/api/executive/goals` stores nested goals, while work
items can reference `goal_id` and `parent_work_id`. The store rejects goal and
work cycles, missing parents, and cross-goal child work. Existing work remains
valid because these references are optional during migration; new material
implementation work can adopt them incrementally.

The liveness audit is now part of the hourly heartbeat and workflow-board
snapshot. A newly stranded item changes the heartbeat attention signature and
produces one owner-facing update; repeated unchanged liveness state is quiet.
The audit remains read-only and recovery remains an explicit operator action.

Work-item evidence is now exposed as the backward-compatible
`executive-evidence/v1` contract. New entries are typed as source, artifact,
test, measurement, decision, diff, or preview; legacy `{label,note,url}`
entries remain readable and normalize to `source`. This makes completion
inspectable without forcing a destructive migration of existing executive
history.

## Adopt next, in priority order

1. Require a durable goal/parent reference for material new implementation
   work, now that the backward-compatible goal/lineage API exists.
2. Define a small adapter contract only if a second trusted execution runtime
   is actually needed. Do not import Paperclip wholesale or add a generic
   plugin surface before there is an in-scope use case.

## Verification evidence

The targeted executive/workflow suites pass, including the full executive
runner suite (296 tests), and the new liveness suite passes. A production
Paperclip cutover is not authorized or required by this decision; the fleet
system remains the source of truth and must continue through its existing
release gates.
