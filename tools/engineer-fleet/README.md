# engineer-fleet

Dynamic, **read-only, zero-token** audit of the Engineer cron role across every
site under `sites/`. Answers: *what engineer does each site have (if any), is it
aligned to the current archetype, and what is each one seeing right now?*

## Usage

```bash
python3 tools/engineer-fleet/engineer-status.py          # full table (all sites)
python3 tools/engineer-fleet/engineer-status.py --drift   # only legacy/partial/missing — alignment check
python3 tools/engineer-fleet/engineer-status.py --json     # machine-readable (for dashboards/cron)
```

## What it reads (writes nothing)

| Column | Source |
|---|---|
| TIER | `aligned` (bash + lock + pulse + daily) · `PARTIAL` · `LEGACY` (role.md, no bash runner) · `none` |
| FEATURES `[LPD]` | `run-engineer.sh`: **L**=work-lock, **P**=liveness-pulse, **D**=daily-Slack-summary |
| CRON | engineer schedule line from `ops/docker/crontab[.docker]` |
| PULSE / AGE / RND / CF / Q | latest `ops/.locks/engineer-status.json` (status, age of last tick, render pass/total, Cloudflare up, queued engineer tasks). `AGE` with `!` = pulse older than 35 min → the engineer may be wedged. |
| FLAGS | `DISABLED` (`ops/.engineer-disabled`), `paused` (`ops/.engineer-paused`), `no-cron-container` (cron container not in `docker ps`) |

## Notes

- The **pulse files are the liveness source of truth**, not Slack — a healthy
  engineer posts to Slack only once/day, so Slack silence is normal. See
  `reference_engineer_pulse_monitoring` and `tools/cron-roles/archetypes/engineer/`.
- A site showing `PULSE=—` simply hasn't fired since its pulse was introduced; it
  fills in within 30 min (cadence `o,o+30 * * * *`).
- To wire alerting later: poll `--json` (or watch each `engineer-status.json`
  mtime) and alert on stale pulse, `status!=green`, or `cf=DOWN`.
```
