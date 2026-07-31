---
name: fleet-git-audit
description: Use when the user asks whether any site (sites/*) or the parent domains repo has outstanding work needing to be committed/pushed — uncommitted changes, unpushed commits, branches with unique commits not on main, open worktrees, or stashes. Triggers on "any sites with uncommitted work", "outstanding branches", "open worktrees across the fleet", "what needs to be pushed". Runs tools/scripts/fleet-git-audit.sh across the parent repo and all 39 sites/* submodules.
---

# Fleet Git Audit

Scans the parent `domains` repo plus every `sites/*` submodule for git state that
hasn't made it to `main` / hasn't been pushed. Wraps a plain bash script, not an
agent loop — deterministic, fast (~5-10s for the whole fleet), no LLM judgment
needed for the scan itself.

## Run it

```bash
tools/scripts/fleet-git-audit.sh          # human-readable report
tools/scripts/fleet-git-audit.sh --json   # machine-readable, for dashboards/cron
```

Exit code: `0` = fleet clean, `1` = at least one repo has findings.

## What it checks, per repo (parent + each submodule)

1. **Dirty working tree** — `git status --porcelain` non-empty
2. **Current branch unpushed** — no upstream, or ahead of `@{u}`
3. **Non-default local branches with unique commits** — anything not merged into `main`/`master`
4. **Extra worktrees** — beyond the primary checkout (e.g. `.claude/worktrees/*`)
5. **Stashes** — any `git stash list` entries

## After running

The script only reports counts/branch names — it does not judge intent. For each
finding:

- **Dirty tree**: run `git status` in that repo to see if it's WIP worth committing
  or noise (e.g. `.deploy-probe` bump files, generated content).
- **Branch with unique commits**: run `git log main..<branch> --oneline` in that
  repo to see what's on it before deciding to merge, PR, or drop.
- **Extra worktree**: check `git worktree list` — matches `superpowers:using-git-worktrees`
  or `.claude/worktrees/` conventions; don't remove without confirming it's not
  active work.
- **Stashes**: follow the `check-uncommitted-work` skill's verification steps
  (spot-check the stash diff against `main`) before dropping.

Do not delete branches, drop stashes, or remove worktrees automatically — this
skill is read-only reconnaissance. Hand findings to the user or to
`check-uncommitted-work` for the cleanup workflow on any repo that needs it.
