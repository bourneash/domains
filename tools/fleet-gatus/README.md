# fleet-gatus (POC)

Gatus as the fleet's health-check dashboard + alerting layer. This is a
**pilot on 3 sites** (wetpages.com, americastrikes.com, reviewtattoo.com) —
not a replacement for `tools/fleet-smoke` yet. See
`memory/project_fleet_gatus_monitoring_2026-08-20.md` for the plan this is
step 1 of.

## Why

`fleet-smoke` posts a full Slack message to every site's channel on every
tick (twice daily), healthy or not — no dedup, no severity, no dashboard,
no trend, checks only assert HTTP status. Gatus adds:

- A real dashboard (color-coded uptime %, per-check history) instead of
  scrolling Slack for status.
- Threshold-based alerting (`failure-threshold`/`success-threshold`) — only
  posts to Slack on an actual state *change*, not every tick.
- 5-minute check interval instead of twice daily — much faster detection.
- Body-content assertions (`[BODY] == pat(*text*)`) as a path to real
  content checks, not just status codes — not used yet in this pilot
  (checks below are 1:1 ports of the existing `expect: <status>` checks),
  but this is the mechanism the "deep checks" phase will build on.

## What this pilot does NOT change

- `tools/fleet-smoke` keeps running exactly as before. This is additive.
- Only 3 sites are wired up (`PILOT_SITES` in `scripts/generate_config.py`).
- Checks are still HTTP-status-only — content-rendering (Playwright,
  broken images, word count) is a later phase via Gatus's external-endpoint
  push API, not built yet.
- No auth in front of the dashboard yet — it's bound to loopback
  (`127.0.0.1:8580`) only. Needs a reverse-proxy + auth (or Tailscale-only
  access) before it's exposed beyond this box.

## Source of truth

Checks are **not** edited here. Each pilot site's own
`sites/<domain>/ops/smoke.yaml` (the same file `fleet-smoke` reads) is the
source of truth. `config/config.yaml` is a generated artifact — gitignored,
regenerated from `smoke.yaml` on demand.

## Run it

```bash
cd tools/fleet-gatus
python3 scripts/generate_config.py   # renders config/config.yaml from the 3 pilot smoke.yaml files
docker compose up -d
```

Dashboard: http://127.0.0.1:8580

To pick up a check change in one of the 3 pilot sites' `smoke.yaml`:

```bash
python3 scripts/generate_config.py && docker compose restart
```

(Gatus hot-reloads config on file change in newer versions — restart is
the safe/guaranteed path for this POC; not yet confirmed whether the
`twinproduction/gatus:stable` tag in use picks up changes without it.)

## Slack alerting

Reuses the existing bot token (`SLACK_BOT_TOKEN` in `domains/.env`) and each
site's existing channel (`slack.channel` in `smoke.yaml`) via Gatus's
`custom` alerting provider posting straight to `chat.postMessage` — no new
Slack app, webhook, or channel needed. Alert fires after 2 consecutive
failed checks (~10 min), resolves after 2 consecutive passes, and posts
exactly once on each transition (not every tick).

## Next steps (not done yet)

1. Let the pilot run a few days, compare signal quality against
   fleet-smoke's Slack output for the same 3 sites.
2. Add body-content assertions for a couple of checks (e.g. article page
   must contain expected heading text) to prove the "deeper checks" story.
3. Put auth + a real hostname in front of the dashboard if it's worth
   keeping.
4. Expand `PILOT_SITES` to the full fleet, retire `fleet-smoke`'s
   Slack-posting code (keep or drop its check runner — TBD), decide
   watchdog integration (phase 2, not in scope here).
