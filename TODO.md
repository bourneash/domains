# Domains — Project TODO

Cross-cutting work for the portfolio and its shared tooling. Per-site and
ad-hoc notes live in `TODO-TASKS.md`; durable fleet conventions live in
`CRON_OPERATIONS.md` and the per-tool memories.

## Fleet Dashboard (`tools/fleet-dashboard`, localhost:4754)

Develop via the `fleet-dashboard-dev` skill. The two items below are the
highest-leverage capability gaps identified 2026-06-27 (after folding the
cron-manager into the Cron tab).

- [ ] **Push alerting + a thin event history (pull → push).** The dashboard is
  point-in-time and pull-only; nothing reaches out and nothing is remembered.
  - Add a watchdog tick (reuse the existing `engineer-status.py` shell-out +
    container/crontab inspection) that diffs current state against the last
    tick and **pushes deltas to Slack** via the existing per-site
    `domain-<host>` channels + Domain Ops bot. Healthy = silent (same
    discipline as the engineer pulse). Fires on: cron container down, CF
    `DOWN`, role overdue, failed rebuild, unpushed/stale deploy, stale crontab.
  - Add a small **event store** (SQLite file or append-only JSONL — the
    dashboard currently has no persistence by design) + a `/api/events` feed
    and a read-only **Activity** tab. Unlocks "down since…", restart counts,
    flap history, and a free audit trail of the mutations the dashboard makes
    (disabled-flags, crontab edits, git commits).
  - Suggested order: event store + watchdog tick + Activity tab first, then
    wire the Slack push once the fired set has been eyeballed.

- [ ] **Unified "Attention" triage view with bulk remediation.** Today the
  signal that something is wrong is scattered across five tabs and every fix is
  one item at a time.
  - One screen aggregating everything broken across all surfaces (cron down,
    stale crontab, CF down, overdue role, failed rebuild, dirty/unpushed repo),
    each row with a fix-it-here action.
  - **Fleet-wide bulk actions**: "rebuild all stale crons", "pause
    content-writer everywhere", "push all sites that are ahead".
  - Builds naturally on the event store from item 1 (which also supplies the
    mutation audit trail).
