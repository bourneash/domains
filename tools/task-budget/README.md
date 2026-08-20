# task-budget

Reusable turn-budget derivation for writer-type cron roles across the fleet,
plus a read-only, zero-token fleet audit — same category of tool as
`tools/engineer-fleet`.

## The problem this fixes

Writer roles (`content-writer`, `news-writer`, etc.) historically got a flat
`--max-turns` for every run, regardless of what the next backlog task
actually needed. An under-scoped task can silently burn the whole flat
budget with nothing committed — this happened on reviewtattoo.com
(2026-07-18: one task ate all 40 turns, nothing shipped) and repeatedly on
0daynews.com (90+ logged timeouts on `news-writer`).

`turn_budget.py` derives the budget from the task's own `estimated_turns`
frontmatter field instead: `min(hard_cap, max(floor, estimated_turns +
buffer))`.

**Only applies to roles that actually pick a task from `ops/tasks/backlog/`
as their unit of work.** Some writer roles (news-scanning pipelines, mandate-
driven roles with no backlog-task granularity) don't fit this model — check
the role's own `.md` doc for a "pick the highest-priority `type: content`
task from `ops/tasks/backlog/`" instruction before wiring it. Forcing this
tool onto a role that doesn't operate that way is a no-op at best.

## Zero dependencies, by design

Stdlib only — no PyYAML. This runs inside each site's worker container via a
read-only bind mount, and most of those containers do **not** have PyYAML
installed (only 0daynews.com's does). Task frontmatter across the fleet is
flat `key: value` pairs (no nesting, no lists), so a hand-rolled parser is
sufficient and avoids that landmine.

## Usage

### Runtime (inside a site's worker container, invoked by `run-role.sh`)

```bash
python3 turn_budget.py runtime <role> [--backlog-dir ops/tasks/backlog] \
  [--hard-cap 40] [--floor 10] [--buffer 8] [--fallback 40]
# → prints ONE integer
```

Wire it into a role's dispatch by reaching the script through whatever mount
that site already has available:

- If the site mounts the whole `tools/` dir at `.monorepo-tools` (check
  `docker-compose.yml`), use `$REPO_ROOT/.monorepo-tools/task-budget/turn_budget.py`.
- Otherwise add a dedicated read-only mount:
  ```yaml
  - ${HOME}/projects/domains/tools/task-budget:/opt/fleet-tools/task-budget:ro
  ```
  and reach it at `/opt/fleet-tools/task-budget/turn_budget.py`.

Always pass `--fallback` matching the role's prior static value, and wrap the
call so any failure (missing mount, no eligible task, bad data) degrades to
that same fallback — this must never block a cron run.

### Fleet audit (host-side, read-only, zero LLM tokens)

```bash
python3 tools/task-budget/turn_budget.py audit            # table, all sites
python3 tools/task-budget/turn_budget.py audit --json      # machine-readable
```

Reports, per site/role: configured static `MAX_TURNS` (scraped from
`run-role.sh` and any `run-<role>.sh` wrapper script) vs. what the dynamic
budget would compute right now, plus **dead-role backlog task drift** —
`assigned_role` values with no matching file in that site's `ops/roles/`.
This surfaces tasks that can never be picked up (they're rotting silently);
the reviewtattoo.com sweep found a live $4,861 Amazon Creator Connections
task buried this way.

## Fleet Dashboard integration

`tools/fleet-dashboard/server/taskbudget.js` shells out to `audit --json`
(same pattern as `server/audit.js` → `engineer-status.py --json`) and exposes
it at `GET /api/task-budget`. The "Task Budget" tab in the dashboard renders
it: static vs. computed turns per role, dispatch type (`run-role.sh` vs. a
dedicated wrapper script), and dead-role task warnings per site.

## Sites wired as of 2026-07-18

| Site | Role | Dispatch | Mount |
|---|---|---|---|
| reviewtattoo.com | content-writer | run-role.sh | dedicated |
| americastrikes.com | news-writer | run-role.sh | `.monorepo-tools` |
| weapontester.com | content-writer | run-role.sh | dedicated |
| ultrarough.com | content | run-role.sh | dedicated |
| aliencouncil.com | content-writer | run-role.sh | `.monorepo-tools` (defense in depth — role already self-limits to one piece/run) |
| 0daynews.com | news-writer | wrapper (`run-news-writer.sh`) | `.monorepo-tools` (partial fix — see note below) |

**0daynews.com caveat:** `news-writer.md` picks a backlog task *or*, if the
backlog is empty, scans live news itself. Only the first mode has a
per-task estimate to derive from. Most of this site's 90+ logged timeouts
are scan-mode runs (its backlog is usually empty), which this tool does not
fix — that needs separate investigation into the scan-mode checklist.

**Explicitly not wired** (wrong operating model — no backlog-task
granularity to derive a budget from): `saveusfarms.com` news-writer(s),
`wetpages.com` content (pulls from `in-progress` + a stub-book fallback),
`xxxtea.com` content-writer (mandate-driven, no backlog concept),
`sinderella.org` (already has its own custom dynamic-budget logic — needs a
look on its own terms, not a drop-in replacement), `aliencouncil.com`
brief-writer/news-desk (news-desk *files* tasks for brief-writer rather than
consuming them as its main loop).
