---
name: domains-cron-role-watchdog
description: Install (or maintain) the self-healing Watchdog cron role on any portfolio site under /home/jesse/projects/domains/sites/. The watchdog runs every 15 min, cheaply probes the live site + deploy state + an incident ledger, and when an OPEN incident exists spins a worker to auto-repair it with a capable model behind an authoritative build gate — bounded by an attempt cap, cooldown, and escalation (priority task + loud Slack). Use when the user asks to "add/install the watchdog", "give <site> self-healing", "make <site> auto-recover from failed deploys/vulns", "wire the watchdog", or "update the watchdog". Stamps from the americastrikes reference. NOTE: cron-direct role — it does NOT use run-worker dispatch, a run-role.sh branch, or task pickup, so it deviates from generic WIRING.md (see below).
---

# Install the Watchdog cron role

Archetype library: `tools/cron-roles/archetypes/watchdog/`
Read `tools/cron-roles/WIRING.md` for the shared mechanics, but the watchdog is
**cron-direct** (`meta.kind: cron-direct`) and overrides several steps. Follow
the procedure below, reading `meta.yml` for schedule/scripts/placeholders/gitignore.

## Why this deviates from generic WIRING
The standard archetypes are worker-dispatched: cron → `run-worker.sh <role>` →
`run-role.sh` → the role. The watchdog is NOT. Its crontab line runs
`run-watchdog.sh` **directly in the cron container** (like `run-deployer.sh`);
that wrapper does the cheap detection at ~0 cost and only spins a worker for the
actual repair pass. So:
- **Skip WIRING Step 6** (run-role.sh branch) — the watchdog never goes through
  run-role.sh. There is no dispatch branch and no Slack-notify allowlist entry
  (it self-notifies).
- **Step 7 (crontab) is different** — the line is `bash ops/scripts/run-watchdog.sh`,
  NOT `run-worker.sh watchdog`.
- **Step 12 dry-run is different** — fire `run-watchdog.sh`, not `run-worker.sh watchdog`.
- `validate-install.sh` (which checks for a run-worker line + run-role branch)
  does NOT apply — use the cron-direct validation in Step F below.

## Procedure

**A. Preconditions (WIRING Step 1) + context (Step 2).** Assert the site follows
the ops pattern (`ops/scripts/run-role.sh`, `notify-slack.sh`,
`ops/docker/crontab.docker`, `Dockerfile.worker`, `docker-compose.yml`, a
`SLACK_CHANNEL_*` in `.env`). Resolve every `meta.placeholders` value via the
`placeholder_detection` hints (BASE_URL, DOMAIN, MODEL, SITE_BRAND, SITE_SHORT,
SLACK_CHANNEL_ENV_VAR, SLACK_CHANNEL_DEFAULT, GIT_USER_NAME, GIT_USER_EMAIL,
BUILD_GATE). For **BUILD_GATE**, grep `site/package.json` scripts: if a
production-audit script exists use `npm run <audit> && npm run build`, else
default `npm run build`.

**B. Stamp scripts (WIRING Step 5).** Copy all three `meta.scripts` from
`archetypes/watchdog/scripts/` into `$TARGET/ops/scripts/`, substituting the
placeholders, drop the `.tmpl` suffix, `chmod +x`. (`run-watchdog.sh` and
`emit-incident.sh` carry no tokens; `watchdog.sh` carries them all.) After
substitution, `grep '{{' ops/scripts/watchdog.sh` must be empty.

**C. Stamp role body (WIRING Step 4).** Copy `role.md.tmpl` →
`$TARGET/ops/roles/watchdog.md`, substitute placeholders, and replace the
`<!-- AWARENESS-BLOCK -->` marker per `handoff-protocol.md` (the watchdog only
produces a `type: engineering` escalation task, so its awareness block is minimal).

**D. Wire the incident contract (REQUIRED — `meta.emits_required_in`).** The
watchdog only detects what gets emitted. Wire the site's failure branches to call
`emit-incident.sh`. At minimum, in `ops/scripts/deploy.sh`, add to the
audit-abort and build-fail branches (before their `exit 1`):
```bash
bash "$REPO_ROOT/ops/scripts/emit-incident.sh" --role deployer --class npm-audit-high --severity high \
  --summary "deploy aborted — high-severity npm vulnerability in a production dependency" --log "$LOG" 2>/dev/null || true
# and for the build-fail branch: --class build-fail --summary "deploy failed — astro build error"
```
Without this, the watchdog still catches `site-down` and `deploy-stuck` via its own
probes, but misses audit/build aborts — the very case it exists for.

**D2. Wire the entrypoint dispatch case (REQUIRED).** `run-watchdog.sh`'s repair
pass runs `docker compose run --rm worker watchdog` (CMD, not `--entrypoint`
override — see the comment in `run-watchdog.sh.tmpl`), so `ops/docker/entrypoint-worker.sh`
must have a dispatch case for it, mirroring the existing `deployer` one:
```bash
if [[ "${1:-}" == "watchdog" ]]; then
  exec bash ops/scripts/watchdog.sh
fi
```
Without this, the container falls through to `ops/scripts/run-role.sh watchdog`
(wrong) or — if an old-style `--entrypoint bash` override is used instead —
skips entrypoint-worker.sh's submodule-gitdir repair entirely, breaking every
git operation in the repair pass with `fatal: not a git repository:
/work/../../.git/modules/sites/<site>` (2026-08-27 amputeenews.com incident).

**E. crontab (WIRING Step 7, cron-direct form) + gitignore (Step 9).** Idempotently
append to `ops/docker/crontab.docker` (skip if a `run-watchdog.sh` line exists):
```
# Watchdog — self-healing incident loop every 15 min (offset off scraper/deployer).
2,17,32,47 * * * *   bash ops/scripts/run-watchdog.sh
```
Append each `meta.gitignore` glob (`ops/health/`, `ops/.watchdog-disabled`) to
`.gitignore` and confirm with `git check-ignore`.

**F. Rebuild + VERIFY (the sinderella guard, Step 11 — cron-direct check).** The
crontab is baked into the cron image, so the new line is invisible until rebuild:
```bash
cd "$TARGET" && docker compose build cron && docker compose up -d cron
# cron-direct validation (validate-install.sh does NOT apply):
docker exec "$(basename "$TARGET" | sed 's/\..*//')-cron" grep -q run-watchdog.sh /etc/crontab.docker && echo "crontab line live ✓"
docker exec "$(basename "$TARGET" | sed 's/\..*//')-cron" bash ops/scripts/run-watchdog.sh   # healthy → "no open incidents", exit 0, no worker spin
```
A worker rebuild is NOT required (watchdog adds no `worker_deps` and reuses the
existing worker for repair) — but if other roles were installed in the same pass,
rebuild `worker cron` together.

**G. Dry-run (Step 12, cron-direct).** Beyond the healthy run in F, seed a fake
incident and confirm the loop drives it (use the dry-run knobs so no tokens/push):
```bash
bash ops/scripts/emit-incident.sh --role probe --class build-fail --severity high --summary "test"
WATCHDOG_DRY_RUN=1 WATCHDOG_FAKE_REPAIR=recover bash ops/scripts/watchdog.sh   # → resolves
rm -rf ops/health   # clean the test incident
```

**H. Commit (Step 13).** Commit `ops/roles/watchdog.md`, the three
`ops/scripts/*.sh`, the `deploy.sh` emit-incident wiring, `crontab.docker`,
`.gitignore` together. State that activation required the cron-image rebuild.

## Maintain mode
If `ops/roles/watchdog.md` already exists, refresh only the role body's awareness
span and re-run F (rebuild + verify). Never clobber operator edits to the scripts
or body. The americastrikes reference is the source of truth for the script logic;
installed copies are stamp-once and tuned per site.
