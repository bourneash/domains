# fleet-gatus

Gatus as the fleet's health-check dashboard + alerting layer, running
**fleet-wide** (all 26 sites with an `ops/smoke.yaml`, 375 checks) alongside
`tools/fleet-smoke`. See `memory/project_fleet_gatus_monitoring_2026-08-20.md`
for the history — this started as a 3-site pilot on 2026-08-20 and expanded
to the full fleet the same day once it proved out.

## Why

`fleet-smoke` posts a full Slack message to every site's channel on every
tick (twice daily), healthy or not — no dedup, no severity, no dashboard,
no trend, checks only assert HTTP status. Gatus adds:

- A real dashboard (color-coded uptime %, per-check history) instead of
  scrolling Slack for status — also surfaced natively in the Fleet Dashboard
  under the "Health" tab (`tools/fleet-dashboard/server/gatushealth.js`).
- Threshold-based alerting (`failure-threshold`/`success-threshold`) — only
  posts to Slack on an actual state *change*, not every tick.
- 5-minute check interval instead of twice daily — much faster detection.
- Body-content assertions (`[BODY] == pat(*text*)`) as a path to real
  content checks, not just status codes — not used yet (checks below are
  1:1 ports of the existing `expect: <status>` checks), but this is the
  mechanism the "deep checks" phase will build on.

## What this does NOT change (yet)

- `tools/fleet-smoke` keeps running exactly as before. This is additive,
  not a cutover — Slack alerting from fleet-smoke is still live for every
  site until a deliberate decision to retire it.
- Checks are still HTTP-status-only. One check fleet-smoke has that Gatus
  can't represent yet: `type: module_graph` (currently only
  0xroulette.com's `/play` — walks the real Vite dynamic-import chunk graph,
  not just a status code). `scripts/generate_config.py` explicitly skips
  it and logs the skip rather than silently mis-representing it; it's still
  covered by fleet-smoke. Real content-rendering checks (broken images,
  word count, DOM assertions) are a later phase via Gatus's
  external-endpoint push API — not built yet.
- No auth in front of the Gatus dashboard itself — it's bound to loopback
  (`127.0.0.1:8580`) only. (The Fleet Dashboard's Health tab, which most
  people should use day-to-day, already sits behind the panel's own auth.)
  Needs a reverse-proxy + auth (or Tailscale-only access) before Gatus's own
  UI is exposed beyond this box.

## Source of truth

Checks are **not** edited here. Each site's own `sites/<domain>/ops/smoke.yaml`
(the same file `fleet-smoke` reads) is the source of truth.
`scripts/generate_config.py` auto-discovers every `sites/*/ops/smoke.yaml`
(same glob fleet-smoke itself uses) and skips any site with
`enabled: false`. `config/config.yaml` is a generated artifact — gitignored,
regenerated on demand, never hand-edited.

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

Reuses the existing bot token (`SLACK_BOT_TOKEN` in `domains/.env`) and each
site's existing channel (`slack.channel` in `smoke.yaml`) via Gatus's
`custom` alerting provider posting straight to `chat.postMessage` — no new
Slack app, webhook, or channel needed. Alert fires after 2 consecutive
failed checks (~10 min), resolves after 2 consecutive passes, and posts
exactly once on each transition (not every tick) — so for now sites get
**two** health signals in Slack: fleet-smoke's existing twice-daily digest,
and Gatus's new threshold-based alerts. Worth revisiting once the fleet-wide
run has proven out (see Next steps).

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

1. Let the fleet-wide run sit for a few days, compare signal quality/noise
   against fleet-smoke's Slack output.
2. Decide whether to silence fleet-smoke's Slack posting (keep its check
   runner or not — TBD) now that Gatus covers the same ground with less
   noise, or keep both running for a while as a redundancy check.
3. Add body-content assertions for a few checks (e.g. an article page must
   contain expected heading text) to prove out the "deeper checks" story.
4. Build the real content-rendering check phase (Playwright: broken images,
   word count, console errors) pushed via Gatus's external-endpoint API —
   this is also what would eventually let `module_graph`-style checks (see
   0xroulette.com) get represented here instead of skipped.
5. Put auth + a real hostname in front of Gatus's own dashboard if it's
   worth exposing beyond the Fleet Dashboard's already-authed Health tab.
6. Decide watchdog integration (`tools/cron-roles/archetypes/watchdog`) —
   phase 2, not started. Watchdog's own detection stays separate for now;
   it's an AI-repair loop, not a duplicate monitor.
