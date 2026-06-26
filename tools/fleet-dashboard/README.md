# fleet-dashboard

Portfolio fleet dashboard — the web successor to
`tools/engineer-fleet/engineer-status.py`, with two new panels on top of the
engineer audit.

Three views, one place (http://127.0.0.1:4754):

- **Engineers** — the live engineer audit: tier (aligned/partial/legacy/none),
  feature flags (work-lock / liveness-pulse / daily-summary), cron schedule,
  latest pulse status + age (stale flag at >35m), render pass/fail, Cloudflare
  health, queued-task count, kill-switch flags, plus a 3-day coverage % and a
  pulse sparkline. This panel **delegates to `engineer-status.py --json`** so the
  tier/pulse/queue logic stays single-sourced in the Python CLI.
- **Git** — per-site working-tree status (each site is its own submodule repo):
  branch, uncommitted-file count, ahead/behind. Expand a row to see the exact
  changed files with their porcelain status codes.
- **Tasks** — full CRUD over each site's `ops/tasks/{backlog,in-progress,done,hold}`
  board: create, edit (frontmatter + markdown body), move between columns, and
  delete. Edits write the markdown files directly; the site's
  engineer/committer picks them up on its next pass (this tool never commits).

Dynamic: any site under `sites/*/ops/` appears automatically. No registry.

## Run

Local (host Node — needs `python3`, `git`, and `docker` on PATH):

    npm install
    npm start            # http://127.0.0.1:4754

Containerized:

    docker compose up -d --build
    # panel at http://127.0.0.1:4754

## Why it shells out to Python

The engineer liveness audit (tiers, pulse parsing, queue counting, cron-line
detection) already lives in `tools/engineer-fleet/engineer-status.py` and is the
documented source of truth (`reference_engineer_pulse_monitoring`). The web
layer calls `--json` / `--history N --json` rather than re-implementing it, so
the CLI and the dashboard can never disagree.

## Safety

- Loopback-only publish (`127.0.0.1:4754`).
- Every `:slug` route is gated through site discovery; columns and filenames
  are validated against an allowlist / regex (no path traversal).
- Task writes are plain file writes/renames/unlinks — no git, no deploy.

## Test

    npm test
