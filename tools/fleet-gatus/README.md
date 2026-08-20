# fleet-gatus

Gatus as the fleet's health-check dashboard + alerting layer, running
fleet-wide (all 26 sites with an `ops/smoke.yaml`, 375 checks). This is the
fleet's only uptime/health monitor — it replaced `tools/fleet-smoke`
(decommissioned 2026-08-20; see
`memory/project_fleet_gatus_monitoring_2026-08-20.md` for the history).

## Why this exists

Fleet health monitoring used to post a full Slack message to every site's
channel on every tick (twice daily), healthy or not — no dedup, no
severity, no dashboard, no trend, checks only asserted HTTP status. Gatus
fixes all of that:

- A real dashboard (color-coded uptime %, per-check history) instead of
  scrolling Slack for status — also surfaced natively in the Fleet
  Dashboard under the "Health" tab
  (`tools/fleet-dashboard/server/gatushealth.js`).
- Threshold-based alerting (`failure-threshold`/`success-threshold`) — only
  posts to Slack on an actual state *change*, not every tick.
- 5-minute check interval instead of twice daily — much faster detection.
- Body-content assertions (`[BODY] == pat(*text*)`) as a path to real
  content checks, not just status codes — not used yet (checks below are
  1:1 ports of the old `expect: <status>` checks), but this is the
  mechanism the "deep checks" phase will build on.

## What's not built yet

- Checks are still HTTP-status-only. One check the old fleet-smoke tool had
  that Gatus can't represent yet: a "module graph" check (currently only
  0xroulette.com's `/play` needs it — walks the real Vite dynamic-import
  chunk graph rather than asserting on a status code). It has **no
  automated coverage right now** — `scripts/generate_config.py` explicitly
  skips it and logs the skip rather than silently mis-representing it.
  Fixing this needs the content-rendering-check phase below.
- Real content-rendering checks (broken images, word count, DOM
  assertions) need a separate Playwright script pushed via Gatus's
  external-endpoint push API — not built yet.
- No auth in front of the Gatus dashboard itself — it's bound to loopback
  (`127.0.0.1:8580`) only. (The Fleet Dashboard's Health tab, which most
  people should use day-to-day, already sits behind the panel's own auth.)
  Needs a reverse-proxy + auth (or Tailscale-only access) before Gatus's own
  UI is exposed beyond this box.

## Source of truth

Checks are **not** edited here. Each site's own `sites/<domain>/ops/smoke.yaml`
is the source of truth (same file name/schema the old fleet-smoke tool used
— unrelated to Gatus itself, kept because every site's `ops/` already has
one). `scripts/generate_config.py` auto-discovers every
`sites/*/ops/smoke.yaml` and skips any site with `enabled: false`.
`config/config.yaml` is a generated artifact — gitignored, regenerated on
demand, never hand-edited.

## Run it

```bash
cd tools/fleet-gatus
python3 scripts/generate_config.py   # renders config/config.yaml from every site's smoke.yaml
docker compose up -d
```

Dashboard: http://127.0.0.1:8580 (raw Gatus UI) or the Fleet Dashboard's
Health tab (http://127.0.0.1:4754/#health) for the themed/integrated view.

To pick up a check change in any site's `smoke.yaml` (add/remove a check,
add a new site, flip `enabled`):

```bash
python3 scripts/generate_config.py && docker compose restart
```

(Gatus hot-reloads config on file change in newer versions — restart is
the safe/guaranteed path here; not yet confirmed whether the
`twinproduction/gatus:stable` tag in use picks up changes without it.)

## Slack alerting

Reuses the fleet's existing bot token (`SLACK_BOT_TOKEN` in `domains/.env`)
and each site's existing channel (`slack.channel` in `smoke.yaml`) via
Gatus's `custom` alerting provider posting straight to `chat.postMessage`
— no new Slack app, webhook, or channel needed. Alert fires after 2
consecutive failed checks (~10 min), resolves after 2 consecutive passes,
and posts exactly once on each transition (not every tick).

## Fleet Dashboard integration

`tools/fleet-dashboard/server/gatushealth.js` polls Gatus's REST API every
60s and serves a rolled-up per-site verdict at `GET /api/gatus`, rendered by
the "Health" tab (`renderHealth()` in `server/public/app.js`) using the
dashboard's own theme — not an embedded Gatus iframe. Only failing checks
are listed by name; a healthy site collapses to a single green badge and a
"N/N checks green" count.

Networking note: fleet-dashboard runs in its own Docker container, so
`127.0.0.1:8580` from inside it is the container's own loopback, not the
host's. `fleet-gatus`'s `docker-compose.yml` joins the same external
`vpn_proxy` network fleet-dashboard uses, so the panel reaches Gatus by
container name (`http://fleet-gatus:8080`) instead.

## Next steps (not done yet)

1. Add body-content assertions for a few checks (e.g. an article page must
   contain expected heading text) to prove out the "deeper checks" story.
2. Build the real content-rendering check phase (Playwright: broken images,
   word count, console errors) pushed via Gatus's external-endpoint API —
   this is also what would let a module-graph-style check (see
   0xroulette.com) get represented here instead of skipped entirely.
3. Put auth + a real hostname in front of Gatus's own dashboard if it's
   worth exposing beyond the Fleet Dashboard's already-authed Health tab.
4. Decide watchdog integration (`tools/cron-roles/archetypes/watchdog`) —
   phase 2, not started. Watchdog's own detection stays separate for now;
   it's an AI-repair loop, not a duplicate monitor.
