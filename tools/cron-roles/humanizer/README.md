# Humanizer checklist (fleet-wide)

Canonical copy of the `blader/humanizer` AI-writing-tell checklist (35
patterns, MIT licensed, based on Wikipedia's "Signs of AI writing"), plus a
stdlib-only scorer. Rolled out fleet-wide 2026-09-02 after a pilot on
reviewtattoo.com's guide-writer (see
`/home/jesse/.claude/projects/-home-jesse-projects-domains/memory/project_humanizer_ab_pilot_reviewtattoo_2026-09-02.md`
for the pilot writeup and backtest numbers).

This is a prompt checklist, not a model or a separate API call — it's
applied by whatever LLM already writes the content. There is no Haiku (or
any other) model involved beyond whichever model already runs the writer
role.

## Files

- `CHECKLIST.md` — the instructions block. Every writer/content role gets
  this appended to its prompt (see "How it's wired" below).
- `humanizer_score.py` — stdlib-only 0-100 "humanity score" for a piece of
  text (no deps, safe to run inside any worker container). CLI:
  `python3 humanizer_score.py <file> [--json]`.
- `LICENSE.txt` — MIT license for the source project (Siqi Chen /
  `blader/humanizer`), kept for attribution.

## How it's wired per role

Two patterns exist across the fleet, matching how each role is dispatched:

1. **Static role prompt** (most `content-writer`, `news-writer`,
   `wire-writer`, editorial roles — generic LLM dispatch just `cat`s the
   role's `.md` file as the prompt): the checklist is appended directly
   into `ops/roles/<role>.md`, near the end, after the site's own voice/
   anti-slop rules (so those are read and internalized first, and are
   called out as taking priority on conflict).
2. **Dynamic prompt assembly** (`guide-writer`, which builds its prompt in
   `ops/scripts/run-guide-writer.sh` from `role.md` + queue-item context):
   the runner script reads the checklist from wherever this tools/ dir is
   mounted (`.monorepo-tools/cron-roles/humanizer/` in containers, falling
   back to `../../tools/cron-roles/humanizer/` in a bare checkout, same
   fallback pattern as `GUIDE_QUEUE_LIB_DIR`) and appends it to the
   assembled prompt every run — no toggle, always on.

Where a run already has an easy post-write hook before commit (guide-writer
does), it also scores the finished body with `humanizer_score.py` and logs
`date,item_id,humanity_score` to a per-site `ops/humanizer-scores.csv`
(committed, not under `ops/logs/` which is gitignored fleet-wide) — purely
for later observability, not a gate. Static-role sites don't have an easy
post-write hook without a bigger dispatch change, so they get the checklist
only, no scoring, for now.

## Explicitly out of scope

- **`social-poster`** and other bash-driven social roles: confirmed
  (2026-09-02) there's no LLM call generating caption/post text anywhere in
  `tools/social-poster` — it posts templated text pointing at already-
  published articles. Nothing to humanize there. If a future social role
  starts generating original copy via an LLM, wire it in then.
- Any role whose writer is disabled (`ops/.content-writer-disabled` marker
  or equivalent) was left untouched.

## Updating the checklist

Edit `CHECKLIST.md` here. This is the single source of truth — per
[[feedback_no_auto_rollout_tool]], propagating an edit to already-stamped
sites is a deliberate, reviewed, per-site action, not an automatic sync.
