# Prerequisite: patch the target site's notify-slack.sh

The principal-engineer role reads `ops/logs/slack-<UTC-date>.jsonl` — a disk
record that does NOT exist until `notify-slack.sh` is patched to write it.
Before 2026-09-06 no site's `notify-slack.sh` logged anything: it was pure
fire-and-forget Slack POST, so a dropped/rate-limited alert left no trace
anywhere. This patch is the fix, and it's a prerequisite for this role on
every site, not something the role can work around.

**This is a per-site patch, not a stamp-from-template step.** A fleet-wide
audit (2026-09-06) found 36 copies of `notify-slack.sh` across 7 distinct
MD5s — it has drifted independently per site with no shared source of truth.
Do not blind-copy americastrikes.com's file over another site's; diff first,
then apply the same *logic* (below) to whatever that site's copy already does.

## What to add

Right after the script parses `$1`/`$2`/`$3` into `CHANNEL`/`TEXT`/`COLOR`
(and validates they're non-empty) — **before** the `SLACK_BOT_TOKEN` check, so
logging happens even if Slack itself isn't configured — insert:

1. Map `COLOR` to a `SEVERITY` (`danger` → `error`, `warning` → `warning`,
   anything else → `info`). If the target site's copy uses raw hex colors
   anywhere non-default, check call sites before assuming the token mapping
   is exhaustive.
2. Best-effort append one JSON line (`{ts, channel, color, severity, text}`,
   UTC ISO8601 `ts`) to `ops/logs/slack-$(date -u +%Y-%m-%d).jsonl`, resolving
   `ops/logs` relative to the script's own location so it works whether
   called from the cron container or the worker container. Wrap the whole
   thing so a write failure can NEVER change this script's exit code or block
   the real Slack post — that guarantee is load-bearing, this script is
   called from dozens of places fleet-wide.

Reference implementation: `sites/americastrikes.com/ops/scripts/notify-slack.sh`
(the `log_to_disk()` function and the severity `case` above it).

## Verify before moving on

- `ops/logs/*` should already be gitignored fleet-wide (checked on
  americastrikes.com; verify on the target site too) — a new `slack-*.jsonl`
  pattern is then already covered. If the target site's `.gitignore` is
  narrower (explicit filenames, not a blanket `ops/logs/*`), add
  `ops/logs/slack-*.jsonl` explicitly.
- Trigger a real Slack call on the site (any existing role's normal heartbeat
  is fine) and confirm a line lands in today's `ops/logs/slack-*.jsonl` with
  the right severity, and that the real Slack post still went through
  unaffected.
