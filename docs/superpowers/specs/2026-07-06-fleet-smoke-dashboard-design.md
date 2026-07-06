# Fleet Smoke Dashboard Panel — Design

## Purpose

`tools/fleet-smoke/` (merged 2026-07-05) centrally runs deterministic health
checks against every opted-in site and posts a Slack status per site. Right
now the only "lever" is editing `sites/<domain>/ops/smoke.yaml` by hand and
the only visibility into its Docker container is the Fleet Dashboard's
generic Cron tab (schedule pause/resume, container restart/rebuild — added
same day as a small path/naming fix so fleet-smoke's cron system is
discoverable there). This adds a dedicated panel to `tools/fleet-dashboard`
for the per-site controls that Cron tab doesn't and can't model: each site's
`enabled`/`slack.enabled` bit-flips, its last check status, and scaffolding a
config for a site that doesn't have one yet.

## Non-goals

- Editing individual check entries (routes/expected codes) from the UI —
  still a direct YAML edit per the `skill-domains-dev-smoke-tester-checks`
  workflow.
- Bulk/batch toggling across sites — every action here is single-site.
- A new check-type authoring UI — check types are added to
  `lib/checks.py` by hand per the skill doc; this panel only consumes
  whatever types already exist in a site's config.

## Architecture

New backend module `tools/fleet-dashboard/server/fleet-smoke.js`, mirroring
the shape of the existing `server/cron.js`. Registers routes in
`server/server.js`. New frontend view added to `server/public/app.js`
(mirrors the existing Cron-tab view's rendering style) plus a "Fleet Smoke"
top-level nav entry, alongside Overview / Domain Control / Cron / Containers.

Backend reads `sites/*/ops/smoke.yaml` directly (Node re-implementation of
the same discovery `fleet-smoke`'s own `lib/config.py` does in Python — the
dashboard is Node-only, so this is a small duplicated read, not a shared
library) and `tools/fleet-smoke/state/<site>.json` for last-run status.
Mutations reuse the existing `server/git.js` `git(cwd, args)` helper
(path-sanitized via its existing `safeRel`, 30s timeout, structured
ok/out/err result) for commit+push — no new git-handling code. "Run now"
reuses `server/containers.js`'s shell-exec pattern (`sh(cmd, args, opts)`)
to `docker exec fleet-smoke python3 run_fleet_smoke.py --only <slug>
--stagger-seconds 0`.

## Backend API

All routes live under `/api/fleet-smoke/`. `:slug` is validated against
`server/sites.js`'s existing site-directory allowlist before any git/exec
call touches it (same guard `server/roles.js`/`server/git.js` routes
already apply via `requireSite`/`safeRel`).

### `GET /api/fleet-smoke/sites`

Returns one row per directory under `sites/`:

```json
{
  "slug": "xxxtea.com",
  "configured": true,
  "enabled": true,
  "slackEnabled": true,
  "checksCount": 14,
  "status": { "icon": "healthy", "pass": 14, "total": 14 }
}
```

`configured: false` sites omit `enabled`/`slackEnabled`/`checksCount` and
have `status: null`. `status` is `null` whenever no
`tools/fleet-smoke/state/<slug>.json` exists yet (never run). `status.icon`
is one of `"healthy" | "recovered" | "attention"`, read straight from
whatever `run_fleet_smoke.py` last wrote (this endpoint does not recompute
it — it has no access to "previous fail count", that comparison already
happened server-side in Python).

### `POST /api/fleet-smoke/:slug/toggle`

Body: `{ "field": "enabled" | "slack.enabled", "value": boolean }`.

1. 404 if the site has no `ops/smoke.yaml`.
2. Parse the YAML (the `yaml` npm package — already a dependency of other
   dashboard modules if present, otherwise add it; no comment-preservation
   attempted, matching how other dashboard writers already behave).
3. Flip the field, write the file back.
4. `git add ops/smoke.yaml && git commit -m "fleet-smoke: toggle <field> for <slug>" && git push origin main` via `git.js`.
5. Response: `{ ok: true, pushed: boolean, row: <updated GET row for this site> }`.
   If the push step fails (offline, diverged, auth), the commit still lands
   locally — return `pushed: false` plus the git stderr, do not report
   overall failure (the toggle itself succeeded and takes effect on the next
   cron tick regardless of push state, since the container reads a live bind
   mount, not git).
6. If the YAML fails to parse, 500 with the parse error — never guess at a
   fix.

### `POST /api/fleet-smoke/:slug/add-config`

1. 409 if `ops/smoke.yaml` already exists for this site — never clobber.
2. Slack channel auto-detect is inherently fuzzy — the 10 sites rolled out in
   the original fleet-smoke build (2026-07-05) don't follow one mechanical
   name transform (`americastrikes.com` → `SLACK_CHANNEL_AMERICA_STRIKES`
   inserts an underscore the domain doesn't have; `rc-9.com` →
   `SLACK_CHANNEL_RC9` drops the dash entirely with no underscore). Given
   that, don't try to compute the exact var name. Instead: take the site's
   stem (segment before the first `.`, dashes stripped, e.g. `rc-9.com` →
   `rc9`, `americastrikes.com` → `americastrikes`), uppercase it, and grep
   `/home/jesse/projects/domains/.env` for every `SLACK_CHANNEL_*` line whose
   name, with underscores stripped, contains that stem. Exactly one match →
   use it (`slack: { enabled: true, channel_env: "<that var name>", channel: "<its value>" }`). Zero or multiple matches → don't guess; scaffold `slack: { enabled: false }` with a comment noting no channel could be
   confidently resolved and to wire it up by hand, same as the
   no-channel-exists case below.
3. Scaffold: `apex: <slug>`, `enabled: true`, one check (`path: /, expect: 200, label: Homepage`).
4. Write, commit (`"ops: add fleet-smoke config (centralized health check)"` — same message Task 8 already used, for consistency), push. Same `pushed` semantics as `/toggle`.
5. Response: the new row.

### `POST /api/fleet-smoke/:slug/run`

1. 404 if not configured. 409 if the `fleet-smoke` container isn't `running`
   (message: "container not running — check the Cron tab").
2. `docker exec fleet-smoke python3 run_fleet_smoke.py --only <slug> --stagger-seconds 0`, 60s timeout.
3. On success: re-read the site's state file, return the fresh row.
4. On non-zero exit or timeout: 500 with the tail of the exec's stdout/stderr
   so the failure is diagnosable from the UI, not just "it failed."

## Frontend

New view function alongside the existing `renderCron`/`renderRoles` in
`app.js`, added to the router and nav bar as "Fleet Smoke". Table columns:
Site | Checks | Slack | Status | Actions.

- Configured sites: two on/off pill toggles (same visual language as the
  existing role-dots) for Checks (`enabled`) and Slack (`slack.enabled`);
  Status cell shows the icon + `pass/total` (or "—" if `status` is null);
  Actions has "Run now".
- Unconfigured sites: `— —` in the toggle columns, a single "+ Add config"
  button in Actions instead of "Run now".
- Clicking a toggle shows a confirm dialog ("This pushes to `<slug>`'s main
  branch — continue?") before POSTing, since every mutating action here is a
  real push to a site that auto-deploys via CF Workers Builds on push to
  main. "Run now" and "+ Add config" get the same confirm treatment for the
  same reason (add-config also pushes).
- Buttons disable + show a spinner while their request is in flight; on
  response, only that row re-renders (reuses the existing "re-render in
  place, preserve scroll" pattern already used by the Containers view).
- Page header shows the `fleet-smoke` container's live status and its next
  scheduled tick, sourced from the existing `/api/cron/systems` response
  (the same data the Cron tab already renders for this system) — not
  duplicated state.

## Testing

Node's built-in `node:test` (matches `cron-manager`'s prior art, which this
dashboard absorbed). Backend module gets dependency-injected `git`/`exec`
functions (default to `git.js`/`containers.js`'s real implementations, test
doubles in tests) so unit tests never touch real git or Docker:

- YAML toggle logic: flips the right field, leaves everything else
  untouched, rejects an unparseable file.
- Add-config scaffold: correct YAML shape, correct channel
  auto-detect/fallback behavior (both branches).
- Route-level guards: unconfigured-site 404 on toggle/run, already-configured
  409 on add-config, non-running-container 409 on run.

No frontend test harness exists in this dashboard to extend — the new view
gets manual verification (load the tab, toggle a real site, confirm the push
lands, confirm "Run now" updates the status cell).
