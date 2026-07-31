---
name: domains-cron-role-deployer
description: Install (or maintain) the zero-AI bash Deployer cron role on any portfolio site under /home/jesse/projects/domains/sites/. The deployer watches for a `.deploy-needed` flag, then builds, audits, commits, pushes, polls Cloudflare Workers Builds for the real build outcome of that exact push (not a blind sleep), runs post-deploy smoke tests against the newest content, and only then reports success — replacing a `claude -p deployer` AI role that burns real tokens on a 100% mechanical job. Use when the user asks to "add/install the deployer", "convert <site> off the AI deployer", "give <site> the bash deployer", "harden <site>'s deploy pipeline", or "wire the deployer archetype". Stamps from a synthesis of americastrikes.com (wrapper) + the 4 sites that independently hand-forked this pattern. NOTE: cron-direct role — it does NOT use run-worker dispatch, a run-role.sh branch, or task pickup, so it deviates from generic WIRING.md (see below), same as the watchdog.
---

# Install the Deployer cron role

Archetype library: `tools/cron-roles/archetypes/deployer/`
Read `tools/cron-roles/WIRING.md` for the shared mechanics, but the deployer is
**cron-direct** (`meta.kind: cron-direct`) and overrides several steps, identically
to how `domains-cron-role-watchdog` overrides them — read that skill's "Why this
deviates from generic WIRING" section for the full rationale if unfamiliar.

## Why this deviates from generic WIRING
The standard archetypes are worker-dispatched: cron → `run-worker.sh <role>` →
`run-role.sh` → the role. The deployer is NOT. Its crontab line runs
`run-deployer.sh` **directly in the cron container**; that wrapper does the
cheap `.deploy-needed` gate at ~0 cost and only spins a worker to run
`deploy.sh` when there's actually something to ship. So:
- **Skip WIRING Step 6** (run-role.sh branch) — the deployer never goes through
  run-role.sh. There is no dispatch branch and no Slack-notify allowlist entry
  (it self-notifies).
- **No role.md.tmpl** — unlike watchdog (which invokes a repair model and needs
  an operating-rules prompt), the deployer never calls `claude -p` at all. There
  is nothing for a role body to instruct. Fleet Dashboard's `roles.js` does not
  read `ops/roles/*.md` for role recognition either — it parses `crontab.docker`
  + `ops/logs/` naming only, and `deployer` is already a first-class recognized
  role name there (`run-deployer.sh` and `run-worker.sh deployer` are both
  matched). Document the role in the site's `CLAUDE.md` role table instead
  (existing convention: "Deployer — When `.deploy-needed` flag exists — Build,
  audit, deploy, smoke test").
- **Step 7 (crontab) is different** — the line is `bash ops/scripts/run-deployer.sh`,
  NOT `run-worker.sh deployer`.
- **Step 12 dry-run is different** — fire `run-deployer.sh`, not `run-worker.sh deployer`.
- `validate-install.sh` (which checks for a run-worker line + run-role branch +
  an `ops/roles/<role>.md` file) does NOT apply — use the cron-direct
  validation in Step F below.

## Procedure

**A. Preconditions (WIRING Step 1) + context (Step 2).** Assert the site follows
the ops pattern (`ops/scripts/notify-slack.sh`, `ops/docker/crontab.docker`,
`docker-compose.yml` with a `/work/.monorepo-tools` bind mount, a `SLACK_CHANNEL_*`
in `.env`, and `site/wrangler.jsonc` with a `"name"` field — worker name is
derived at runtime, never a placeholder). Resolve every `meta.placeholders`
value via the `placeholder_detection` hints (DOMAIN, BASE_URL, GIT_USER_NAME,
GIT_USER_EMAIL, SLACK_CHANNEL_VAR, SLACK_CHANNEL_DEFAULT, SMOKE_TEST_CMD,
DEPLOY_ADD_PATHS). Pay special attention to **SMOKE_TEST_CMD**: if the site has
no `ops/scripts/run-smoke-tests.sh`, write one before installing — it must check
at least one dynamically-newest piece of content (article/case/etc, by mtime),
not just static core pages, or it cannot catch a build that silently omits new
content while still serving old pages 200 (the exact gap in the 2026-07-29
0daynews.com incident this archetype exists to prevent).

**A2. Check for the wrangler-direct variant.** If this site deploys via a
direct `npx wrangler deploy` from the worker container instead of relying on
git-push-triggered Cloudflare Workers Builds (check `ops/scripts/deploy.sh` or
equivalent for a `wrangler deploy` call with no push-then-wait step) — e.g.
0xroulette.com, rc-9.com — apply `meta.known_variants.wrangler_direct`: omit
deploy.sh Step 3 (the CF Workers Build polling block) entirely and replace it
with the site's existing `wrangler deploy` call, treating its exit code as
authoritative. Everything else in the template stays as-is.

**B. Stamp scripts (WIRING Step 5).** Copy both `meta.scripts` from
`archetypes/deployer/scripts/` into `$TARGET/ops/scripts/`, substituting the
placeholders, drop the `.tmpl` suffix, `chmod +x`. After substitution,
`grep '{{' ops/scripts/deploy.sh ops/scripts/run-deployer.sh` must be empty.

**C. No role body to stamp.** Skip WIRING Step 4 entirely (no `role.md.tmpl`
exists for this archetype). Instead, add or update the "Deployer" row in the
site's `CLAUDE.md` role table if one doesn't already describe it.

**D. Incident emission is self-contained.** Unlike watchdog's
`emits_required_in` contract (which depends on OTHER roles remembering to call
`emit-incident.sh`), the deployer calls it internally on every failure branch
(wrong-branch, npm-audit-high, build-fail, push-fail, cf-build-fail,
smoke-fail) — no external wiring required. If the site's watchdog is already
installed, it picks these up for free; if not, the calls are inert no-ops
(`emit_incident()` guards on `ops/scripts/emit-incident.sh` existing).

**E. crontab (WIRING Step 7, cron-direct form) + gitignore (Step 9).**
Idempotently append to `ops/docker/crontab.docker` (skip if a `run-deployer.sh`
line exists):
```
# Deployer — zero-AI bash deploy, fires every 5 min, only when .deploy-needed exists.
*/5 * * * *   bash ops/scripts/run-deployer.sh
```
If this site currently dispatches deployer through `run-role.sh` (either an
existing hand-forked `deploy.sh` called via `run-worker.sh deployer`, or a
`claude -p deployer` AI role), **remove that crontab line and the now-dead
`run-role.sh` deployer branch** as part of this same install — don't leave two
deploy paths active. Append each `meta.gitignore` glob (`ops/.deploy-attempts`,
`ops/.deploy-needed.failed`) to `.gitignore` and confirm with `git check-ignore`.

**F. Rebuild + VERIFY (the sinderella guard, Step 11 — cron-direct check).**
The crontab is baked into the cron image, so the new line is invisible until
rebuild:
```bash
cd "$TARGET" && docker compose build cron && docker compose up -d cron
# cron-direct validation (validate-install.sh does NOT apply):
docker exec "$(basename "$TARGET" | sed 's/\..*//')-cron" grep -q run-deployer.sh /etc/crontab.docker && echo "crontab line live ✓"
# Dry-run: with no .deploy-needed present this must exit 0 doing nothing.
docker exec "$(basename "$TARGET" | sed 's/\..*//')-cron" bash ops/scripts/run-deployer.sh   # no flag → exit 0 immediately, no worker spin
```
A worker rebuild is NOT required (the deployer adds no `worker_deps`) — but if
other roles were installed in the same pass, rebuild `worker cron` together.

**G. Supervised first real deploy (Step 12, cron-direct).** Touch
`.deploy-needed` on a low-stakes commit (or wait for the next natural content
commit) and watch it run end-to-end:
```bash
touch .deploy-needed
bash ops/scripts/run-deployer.sh   # or wait for the cron tick
tail -f ops/logs/deployer-*.log
```
Confirm: branch guard passes, build/audit run, push succeeds, the CF-build-poll
block resolves to a real `success` outcome (not the sleep fallback — check the
log for "CF Workers Build succeeded"), smoke tests pass against the newest
content, and Slack receives "Deploy shipped and verified live" only after all
of that — not before. Also worth deliberately breaking one commit (bad syntax)
to confirm the failure path posts the real CF build-log excerpt to Slack rather
than a generic message.

**H. Commit (Step 13).** Commit `ops/scripts/deploy.sh`,
`ops/scripts/run-deployer.sh`, `crontab.docker`, `.gitignore`, and the
`CLAUDE.md` role-table update together. If this replaced a `claude -p deployer`
AI role or a hand-forked bash `deploy.sh`, note that in the commit message and
remove the now-dead `ops/roles/deployer.md` (AI-role case) or the old
divergent script (hand-forked case).

## Maintain mode
Per `tools/cron-roles/README.md`'s stamp-once philosophy, there is no
auto-resync. If `ops/scripts/deploy.sh` already exists from this archetype and
the canonical template improves later, re-stamp deliberately (re-run Steps
A–B, diff before overwriting, preserve any site-specific optional hooks —
`ops/scripts/reconcile-orphan-content.sh`, `check-live-images.sh`,
`share-new-articles-slack.sh`, `indexnow.sh` — since `deploy.sh` calls those
conditionally by file-existence check, they survive a re-stamp untouched
regardless). Never overwrite operator tuning silently.
