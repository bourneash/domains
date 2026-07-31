# Deployer cron-role archetype — fleet migration status + continuation prompt

## Context

On 2026-07-29, 0daynews.com's bash `deploy.sh` declared "shipped and verified
live" off a homepage-only curl check, while the actual Cloudflare Workers Build
for that push had **failed** in ~2 minutes (a transient git-clone error, no
retry) — an article sat 404ing for 37 minutes until an unrelated later push
happened to succeed and carry it along. The fix (poll the real CF Workers
Builds API for the build matching the pushed commit SHA, fail fast with the
real log on failure) was applied to 4 sites, then formalized into a shared,
installable `tools/cron-roles/archetypes/deployer/` template — matching the
existing pattern for `engineer`, `watchdog`, `content-writer`, etc. — instead
of staying 4+ hand-forked copies. Jesse asked for this rolled out fleet-wide
and surfaced in the Fleet Dashboard.

**Full original design plan:** see the plan approved via `EnterPlanMode` this
session — if not still in `~/.claude/plans/`, this doc is the source of truth
going forward.

## Key references (read these first)

- **Archetype**: `tools/cron-roles/archetypes/deployer/`
  - `meta.yml` — full design rationale, placeholders, known variants
    (`wrangler_direct` for direct-wrangler-deploy sites), the `SKIP_LOCAL_BUILD`
    escape-hatch env var, and why this archetype has no `role.md.tmpl` (it
    never calls `claude -p` at all, unlike watchdog).
  - `scripts/deploy.sh.tmpl` — the canonical build→commit→push→CF-poll→smoke
    body.
  - `scripts/run-deployer.sh.tmpl` — the cron-direct wrapper (retry cap,
    30-min auto-recovery cooldown, signal-kill-safe), sourced verbatim from
    americastrikes.com.
- **Install skill**: `.claude/skills/domains-cron-role-deployer/SKILL.md` —
  full install procedure, cron-direct deviations from generic `WIRING.md`,
  maintain-mode notes. Read this before touching any site.
- **Precedent to mirror**: `.claude/skills/domains-cron-role-watchdog/SKILL.md`
  and `tools/cron-roles/archetypes/watchdog/` — the deployer is cron-direct
  like watchdog, so when in doubt about "does X apply here," check how
  watchdog handles it.
- **tools/cron-roles/README.md**, `WIRING.md`, `handoff-protocol.md` — general
  archetype philosophy: stamp-once (copy + token-substitute, never symlink,
  never auto-resynced), best-impl-wins (though this archetype was a
  multi-source synthesis, documented as an exception in its `meta.yml`).

## Status as of 2026-07-29 (end of this session)

### Done — Phase 0: archetype authored
`tools/cron-roles/archetypes/deployer/{meta.yml,scripts/deploy.sh.tmpl,scripts/run-deployer.sh.tmpl}`

### Done — Phase 1: install skill written
`.claude/skills/domains-cron-role-deployer/SKILL.md`

### Done — Phase 2: 4 sites already on bash deploy.sh, retrofitted/verified live
| Site | What happened |
|---|---|
| 0daynews.com | Full regeneration. Verified via 2 real live deploy cycles (build→push→CF-poll→smoke, all real, all green). |
| americastrikes.com | **Light touch only** — it was literally the archetype's source (best-in-class already: retry-on-lock-contention git-add, elaborate image-completeness gate). Just added attribution comment + confirmed dead `run-role.sh` deployer branch is unreachable (left as-is, not worth the edit risk). |
| saveusfarms.com | Full regeneration, verified live. |
| aliencouncil.com | Full regeneration, verified live. **Fixed a real bug in passing**: git commit author was hardcoded to `"Engineer Bot"` (copy-paste leftover) — now `"The Council Desk"`. |

### In progress — Phase 3: convert the AI-role (`claude -p deployer`) sites
**Done:**
- **reviewtattoo.com** — converted. This one needed a genuinely different
  variant (documented at the top of its `ops/scripts/deploy.sh`): its deployer
  is deliberately a **"verify-only" variant** — never builds, never commits
  (content-writer/affiliate-editor already commit their own work; deployer
  only audits, pushes whatever is on `HEAD`, polls CF, smoke-tests). Also
  found+fixed a real doc-drift bug: `CLAUDE.md` said "Cloudflare Pages" but
  it's actually been a Worker (confirmed directly against the CF API,
  `workers/services/reviewtattoo` returns 200) — fixed the docs.
- **sinderella.org** — converted and pushed (`2164cd9`). Installed the
  standard Workers-Builds bash deployer while preserving its rendered
  forbidden-phrase voice-regex gate; its scheduled Voice Auditor continues to
  own qualitative voice scoring. Rebuilt the cron image and verified the baked
  cron-direct line plus an inert no-sentinel run (exit 0, no retry state).
- **3boobs.com** — converted and pushed (`da38359`, `4a0b9b1`). Added a
  password-preview-aware production smoke test that checks the homepage,
  gallery, and the newest manifest-backed artwork by source mtime. Rebuilt the
  cron image and verified the baked cron-direct line plus an inert no-sentinel
  run (exit 0, no retry state).
- **deeppenetrations.com** — converted and pushed (`81307d5`, `67a0c00`).
  Added a production smoke check for the newest route from the most recently
  modified content-data source, then rebuilt and inert-validated the cron
  wrapper (exit 0, no retry state).
- **totaljerks.com** — converted and pushed (`a689779`, `4c27799`). Rebuilt
  cron and verified the baked cron-direct wrapper with an inert no-sentinel
  run (exit 0, no retry state).
- **weapontester.com** — converted and pushed (`9ba0364`, `2e58334`). Reused
  its route-aware render-health check for post-deploy smoke coverage; rebuilt
  cron and verified an inert no-sentinel wrapper run (exit 0, no retry state).

**Not started — remaining sites, in two buckets:**

1. **Standard conversion** (use CF Workers Builds git-integration — the
   full archetype applies): shoptopless.com, ultrarough.com, wetpages.com,
   xxxtea.com. broadwayshowgirls.com was **separately already
   fixed earlier this session** (its existing real `run-smoke-tests.sh` was
   dead code, never called by `post-write.sh` — wired it in; it doesn't use
   the deployer-role pattern at all, no further action needed there).

2. **`wrangler_direct` variant** (direct `npx wrangler deploy` from the
   container, no async CF-build gap to poll — see
   `meta.yml.known_variants.wrangler_direct`): 0xroulette.com, rc-9.com.

### Not started — Phase 4: Fleet Dashboard extension
Extend `tools/fleet-dashboard/server/deployhealth.js`'s `checkOne()` to also
poll the Workers Builds API (matching commit hash — the same call `deploy.sh`
now makes) alongside its existing versions-endpoint check, so the dashboard's
"Deploys" tab / `deployer` role-cell surfaces the *actual CF failure reason*
instead of just "behind/stale." No new tab needed — `deployer` is already a
first-class recognized role there (`roles.js`'s `roleFromCommand()`), and the
Deploys tab (`renderDeployHealth()` in `app.js`, tagged "F27") already exists.
See the full architecture notes captured mid-session (not persisted elsewhere
— re-derive via `Read` on `tools/fleet-dashboard/server/{server.js,roles.js,deployhealth.js}`
and `server/public/app.js`'s `renderDeployHealth`/`roleDot` functions if this
doc is your only context).

### Not started — Phase 5: docs
Add `deployer` as the 8th entry in `tools/cron-roles/README.md`'s role table.

## The procedure that worked (repeat this per site)

1. **Investigate before touching anything:**
   - `grep -n "SKIP_LOCAL_BUILD\|SKIP_SMOKE\|SKIP_SITE_DEPS" docker-compose.yml`
     — a hardcoded `SKIP_LOCAL_BUILD=1` means the container genuinely can't
     run `npm run build` (Alpine/musl vs. Cloudflare's glibc-only workerd) —
     the template already respects this env var, just confirm it's set if the
     site needs it.
   - Read the current deploy mechanism in full: `ops/scripts/deploy.sh` (if
     bash-driven) or `ops/roles/deployer.md` (if AI-role-driven) — does it
     commit its own work, or is it verify-only like reviewtattoo? Does it have
     any site-specific gate (image-completeness, orphan-content
     reconciliation) worth preserving as an optional file-existence-gated hook?
   - Confirm the actual CF deploy mechanism directly against the API, don't
     trust `CLAUDE.md` — `curl .../workers/services/<name>` (200 = Worker) vs
     `.../pages/projects/<name>` (should 403 — the shared token has zero Pages
     scope). Check `.../builds/workers/<script_tag>` for git-integration
     config (script_tag comes from the services response's
     `default_environment.script.tag`).
   - `grep -n "deployer" ops/scripts/run-role.sh ops/docker/crontab.docker` —
     is it worker-dispatched (`run-worker.sh deployer` → `run-role.sh`'s
     deployer branch) or already cron-direct?
2. **Generate the two scripts** from the templates via simple Python
   string-replace on the `{{PLACEHOLDER}}` tokens (see `meta.yml.placeholders`
   for the full list) — or hand-write a variant `deploy.sh` (matching the
   template's structure/comments/notify conventions) if the site's design
   genuinely diverges, as with reviewtattoo. `chmod +x`, `bash -n` both files.
3. **Commit + push immediately** — before touching crontab/run-role.sh, before
   any docker rebuild. **This is a hard lesson from this session**: leaving
   uncommitted infra changes sitting in a live site's working tree risks them
   getting swept into an unrelated commit by that site's OWN autonomous roles
   running concurrently (happened on 0daynews — its live `engineer` role
   committed and the deployer then pushed, using the new script, before I'd
   even reviewed it myself). Commit fast, in small scoped chunks, per file
   group.
4. **Wire crontab.docker**: replace the old `[ -f .deploy-needed ] || bash
   ops/scripts/run-worker.sh deployer` (or similar) line with `bash
   ops/scripts/run-deployer.sh`, preserving the site's existing cadence/time
   window if it has one (e.g. aliencouncil's `6-22` hour restriction).
5. **Retire the dead `run-role.sh` deployer branch** — but judge the risk:
   if it's a clean, isolated `elif`/`if` block (0daynews, saveusfarms,
   aliencouncil), remove it. If it's tangled into a complex config-table /
   post-run Slack-detection block (americastrikes, reviewtattoo), **leave it
   in place** — it's harmless and unreachable once crontab no longer calls
   `run-worker.sh deployer`, and editing it risks a syntax mistake for zero
   functional gain. Always update the header "Roles:" comment and `usage:`
   line either way (cheap, safe, isolated string edits).
6. **Retire `ops/roles/deployer.md`** (AI-role sites only) — `git mv` to
   `deployer.md.archived`, don't delete outright.
7. **gitignore**: add `.deploy-attempts` and `.deploy-needed.failed` (and
   `.deploy-needed` itself if not already present).
8. **Commit this second batch**, then **rebuild + verify live**:
   ```bash
   docker compose build cron && docker compose up -d cron
   docker exec $(docker compose ps -q cron) grep -n "run-deployer.sh" /etc/crontab.docker
   docker exec $(docker compose ps -q cron) bash ops/scripts/run-deployer.sh; echo "exit=$?"
   ```
   With no `.deploy-needed` present this must exit 0 immediately, no worker
   spun, no `.deploy-attempts` file created. That's the "safe, inert,
   correctly wired" signal — do NOT manually touch `.deploy-needed` yourself
   to force a real deploy; let the site's own content cadence trigger the
   first real run and check its log afterward
   (`ops/logs/deployer-*.log`).
9. Fix any stale docs found along the way (CLAUDE.md, role comments) — cheap,
   valuable, low-risk.

## Continuation prompt

Paste this into a fresh session to pick the migration back up:

> Continue the deployer cron-role archetype migration described in
> `docs/superpowers/plans/2026-07-29-deployer-archetype-migration.md` in
> `/home/jesse/projects/domains`. Read that file in full first — it has the
> archetype location, the install skill, the exact per-site procedure that
> worked (including the "commit immediately before any docker rebuild" lesson
> and how to tell whether a site needs the standard template, the
> `wrangler_direct` variant, or a custom variant like reviewtattoo's
> verify-only deployer), and the current status of every site. Pick up with
> whichever site is next in the "Not started" list under Phase 3, or Phase 4
> (Fleet Dashboard `deployhealth.js` extension) if Phase 3 is complete. Work
> one site at a time, verify each live (rebuild the cron container, confirm
> the new crontab line, run an inert dry-run with no `.deploy-needed` present)
> before moving to the next, and check in periodically rather than blasting
> through the whole remaining list unsupervised — this touches live
> production/revenue sites.
