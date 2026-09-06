---
name: domains-cron-role-principal-engineer
description: Install (or maintain) the fleet's Principal Engineer cron role on any portfolio site under /home/jesse/projects/domains/sites/. Every 5 minutes, cheaply scans that site's ops/logs/slack-*.jsonl (the disk record notify-slack.sh now writes for every post) for new error/warning entries; on a distinct, real one it posts a Slack "on it" ack, dispatches the worker container to investigate/fix/harden/self-review, then reports the resolution (root cause, fix, hardening) or escalates. Fleet-wide rollout candidates are flagged as a human-triage backlog task, never auto-applied. Use when the user asks to "add/install the principal engineer", "give <site> a senior-engineer role", "react to Slack errors automatically", "wire the principal engineer", or "update the principal engineer". Stamps from the americastrikes.com reference (piloted 2026-09-06). NOTE — cron-direct role, same deviations from generic WIRING.md as the watchdog skill, PLUS a mandatory notify-slack.sh disk-logging patch that must land first.
---

# Install the Principal Engineer cron role

Archetype library: `tools/cron-roles/archetypes/principal-engineer/`
Read `tools/cron-roles/WIRING.md` for shared mechanics, but this is
**cron-direct** (`meta.kind: cron-direct`, same family as `watchdog`) and has
one extra prerequisite watchdog doesn't: a working disk log of Slack posts.

## How this role differs from engineer and watchdog
- **`engineer`** = periodic health-check monitor (renders, git, CF, task
  queue) — detects issues itself on a schedule.
- **`watchdog`** = self-heals a small set of KNOWN infra failure classes that
  other roles explicitly `emit-incident.sh` into.
- **`principal-engineer`** = reacts to **anything that already reached
  Slack** as an error/warning, from any role or script, with no per-emitter
  wiring required — because it watches the Slack log itself, not a bespoke
  incident contract. It's the one role explicitly meant to investigate,
  fix, HARDEN (not just patch), self-review its own decision, and flag
  (never auto-execute) fleet-wide rollout candidates.

All three can coexist on one site with no overlap: they read different
signals and dispatch independently.

## Procedure

**A. Prerequisite — patch notify-slack.sh first.** This role has nothing to
read until the target site's `notify-slack.sh` writes
`ops/logs/slack-<date>.jsonl`. Follow
`tools/cron-roles/archetypes/principal-engineer/NOTIFY-SLACK-PATCH.md`
exactly — **do not skip this thinking the archetype scripts alone are
enough.** Verify with a real Slack-triggering event before moving on.

**B. Preconditions + placeholders.** Same as watchdog Step A: assert the
site follows the ops pattern (`run-role.sh`, `notify-slack.sh`,
`ops/docker/crontab.docker`, `Dockerfile.worker`, `docker-compose.yml`, a
`SLACK_CHANNEL_*` var). Resolve every `meta.placeholders` value via
`placeholder_detection` — for **BUILD_GATE** and **SLACK_CHANNEL_ENV_VAR**,
reuse the exact values the site's existing `engineer`/`watchdog` archetype
already uses (grep `run-engineer.sh` or `watchdog.sh`) rather than
re-deriving them; they must match or the two roles will build-gate
differently for no reason.

**C. Stamp scripts.** Copy all three `meta.scripts` from
`archetypes/principal-engineer/scripts/` into `$TARGET/ops/scripts/`,
substitute placeholders, drop `.tmpl`, `chmod +x` all three (including the
`.py`). After substitution, `grep -n '{{' ops/scripts/principal-engineer*.sh ops/scripts/run-principal-engineer.sh`
must be empty. `principal-engineer-scan.py.tmpl` has no placeholders (it's
site-agnostic — it reads REPO_ROOT from its own path) — copy it verbatim,
just drop `.tmpl`.

**D. Stamp role body.** Copy `role.md.tmpl` → `$TARGET/ops/roles/principal-engineer.md`,
substitute `{{SITE_BRAND}}`.

**E. Dispatch mechanism — verify, don't assume.** `run-principal-engineer.sh`
spins the repair pass with
`docker compose run --rm --entrypoint bash worker ops/scripts/principal-engineer.sh <fingerprint>`
— the same `--entrypoint bash` form americastrikes.com's `run-watchdog.sh`
already uses in production (proven working end-to-end 2026-09-06, including
a real git push, after [[feedback_runner_needs_standalone_gitdir]]'s fix). If
an older skill note claims `--entrypoint bash` breaks git ops on a given
site, that's a signal that site still has the old submodule-absorbed `.git`,
not a reason to switch dispatch forms — fix the gitdir instead.

**F. Crontab + gitignore.** Idempotently append to `ops/docker/crontab.docker`
(skip if a `run-principal-engineer.sh` line already exists) — copy the
commented block from `americastrikes.com`'s crontab.docker verbatim (schedule
+ rationale), substituting nothing (the schedule is fleet-generic: offset
+1 off any `*/5` deployer and `*/15` scraper ticks; confirm it doesn't
collide with THIS site's own watchdog/engineer minutes before committing to
it — adjust the offset if it does). Append each `meta.gitignore` glob and
confirm with `git check-ignore`; `ops/logs/*` is usually already a blanket
rule fleet-wide, so the slack-log glob is likely already covered — check
before adding a redundant line.

**G. Activate + verify (the sinderella guard).** Confirm how THIS site's cron
container gets a new crontab line — `meta.needs_rebuild_verify` is `false`
for americastrikes.com because its `crontab.docker` is bind-mounted
(`docker restart <site>-cron` is enough), but some older sites still bake it
into the image (`docker compose build cron && docker compose up -d cron`).
Check the `docker-compose.yml` cron service's `volumes:` before assuming
either way. Then:
```bash
docker exec <site>-cron cat /etc/crontab.docker | grep -A1 principal-engineer   # line present?
docker exec <site>-cron ps aux | grep supercronic                              # scheduler alive?
cd "$TARGET" && bash ops/scripts/run-principal-engineer.sh; echo "exit=$?"      # idle tick: fast exit, 0 tokens, no Slack
cat ops/.locks/principal-engineer-cursor.json                                   # cursor advanced?
```

**H. Seeded end-to-end dry run (do this before trusting the install).**
```bash
bash ops/scripts/notify-slack.sh <real-channel> "TEST synthetic failure: <anything>" danger
python3 ops/scripts/principal-engineer-scan.py   # confirm {"action":"act",...} and an incident file appears
docker compose run --rm --entrypoint bash worker ops/scripts/principal-engineer.sh <fp-from-above>
```
This spends real tokens (the model actually runs) — that's expected; a
synthetic "TEST ..." message is recognized by convention and the model should
report `PE_STATUS=resolved-noise` quickly. After it completes: `git log -1`
(a real, sane commit — the reference install also self-hardened
`principal-engineer-scan.py` to skip future `TEST `-prefixed/`synthetic
failure`-marked messages, which is a legitimate improvement worth keeping,
not something to revert), `git status --short` (clean), and
`ops/logs/token-usage-*.jsonl` (a new `principal-engineer` line, confirming
it's visible in the Fleet Dashboard AI Usage tab with zero extra plumbing).
Then `rm -rf ops/health/principal-incidents/*` to clear the test incident
before the site goes live for real.

**I. Commit.** Commit `ops/roles/principal-engineer.md`, the three
`ops/scripts/*` files, the `notify-slack.sh` patch, `crontab.docker`, and any
`.gitignore` additions together. Note in the commit message that activation
required a cron container restart (and rebuild, if this site bakes its
crontab into the image).

## Maintain mode
If already installed, refresh only the role body / script logic that
changed upstream and re-run G+H. Never clobber operator edits. The
americastrikes.com install is the source of truth for script logic —
installed copies are stamp-once and tuned per site, same as engineer/watchdog.
