---
ticket_id: 2026-09-21-blackmarketapparel-com-entrypoint-worker-sh-has-marineactivi
status: applied
title: "blackmarketapparel.com: entrypoint-worker.sh has marineactivity.com git-store path — all worker roles exit 78 before running"
created: 2026-09-21
decided: 2026-09-21
finding_class: wrong-site-template-copy
dedupe_key: 9e7336f8672bf1f3
scope: site
sites: [blackmarketapparel.com]
role: principal-engineer
window_from: 2026-09-15
window_to: 2026-09-21
measured_cost_usd: 11.65
estimated_savings_usd_per_day: 4.0
risk: low
verified_current_code: true
verified_git_check: "Read ops/docker/entrypoint-worker.sh lines 26-41: the git-store check at line 27 tests for [[ -d /git-store/marineactivity.com ]]. docker-compose.yml line 45 mounts the actual git-store at /git-store/blackmarketapparel.com. /git-store/marineactivity.com never exists in the container, so the entrypoint always hits the else branch and exits 78. PE dispatches via run-principal-engineer.sh use --entrypoint bash (line 112 of run-principal-engineer.sh), bypassing entrypoint-worker.sh entirely — PE itself works. All standard worker-container roles (engineer, deployer, watchdog, promoter) are invoked via normal entrypoint dispatch and all exit 78 before any role logic runs. After 5 consecutive exit-78 deployer failures, run-deployer.sh:67 posts a Slack alert ('deployer halted after 5 failures — content not publishing'). PE is then dispatched to investigate a deployer that consistently fails with a non-obvious error; 8 of 54 PE calls hit max_turns (all on 2026-09-21, the site's first full operating day), wasting $11.65."
evidence_files: ["sites/blackmarketapparel.com/ops/docker/entrypoint-worker.sh:27", "sites/blackmarketapparel.com/docker-compose.yml:45", "sites/blackmarketapparel.com/ops/scripts/run-deployer.sh:67"]
decided_by: codex
decision_note: Applied the site-specific git-store/user identity fix in entrypoint-worker.sh and moved generic Claude dispatch out of the social-poster branch; bash syntax and affected fleet tests pass.
---

## Problem

`ops/docker/entrypoint-worker.sh` was scaffolded from the marineactivity.com template and the site-specific strings were never updated. Lines 27–41 reference `marineactivity.com` throughout:

- **Line 27**: `if [[ -d /git-store/marineactivity.com ]]` — checks the wrong mount path
- **Line 28**: `export GIT_DIR=/git-store/marineactivity.com` — wrong gitdir
- **Line 31**: error message names `marineactivity.com`
- **Lines 36-37**: git config fallbacks default to `MarineActivity Bot` / `bot@marineactivity.com`
- **Line 40**: `safe.directory` registration uses wrong path

`docker-compose.yml:45` mounts the git-store at `/git-store/blackmarketapparel.com`. The path `/git-store/marineactivity.com` never exists in the container, so the `if` at line 27 always falls to the `else` branch and exits 78 before any role dispatch code runs.

The `principal-engineer` is insulated from this bug: `run-principal-engineer.sh:112` uses `--entrypoint bash` to invoke `principal-engineer.sh` directly, bypassing `entrypoint-worker.sh` entirely. Every other scheduled role that uses the standard worker dispatch (`engineer`, `deployer`, `watchdog`, `promoter`) exits 78 before any work is done.

`run-deployer.sh` increments `.deploy-attempts` before each docker run and does not reset it on exit 78 (only 130/143 are excluded). After 5 consecutive exit-78 failures it renames `.deploy-needed` → `.deploy-needed.failed` and posts a Slack alert: *'deployer halted after 5 failures — content not publishing'*. That alert is then picked up by `principal-engineer-scan.py` and dispatches the PE worker. The PE investigating why deployer keeps exiting 78 faces a non-obvious root cause (wrong path in the entrypoint, not in deployer logic). This is consistent with 8 of 54 PE calls hitting max_turns on the site's first full operating day ($11.65 wasted).

## Proposed change

In `ops/docker/entrypoint-worker.sh`, replace every `marineactivity.com` occurrence (lines 27–41) with `blackmarketapparel.com`:

```bash
# line 27
  if [[ -d /git-store/blackmarketapparel.com ]]; then
# line 28
    export GIT_DIR=/git-store/blackmarketapparel.com
    export GIT_WORK_TREE=/work
# line 31
    echo "[entrypoint] ERROR: submodule gitdir /git-store/blackmarketapparel.com is not mounted" >&2
# line 36
git config --global user.name  "${GIT_USER_NAME:-Blackmarket Apparel Bot}"
# line 37
git config --global user.email "${GIT_USER_EMAIL:-bot@blackmarketapparel.com}"
# line 40
git config --global --add safe.directory /git-store/blackmarketapparel.com
```

## Secondary finding (mentioned for completeness)

`ops/scripts/run-role.sh` has the `case`/`_run_claude()` block nested inside the `elif [[ "$ROLE" == "social-poster" ]]` branch (lines 172–232). For any role not handled by an explicit elif (currently only `promoter` from the cron schedule), `STATUS` is never assigned and the script hits `set -euo pipefail` on line 234's `$STATUS` reference. This bug is currently masked by the entrypoint exit-78 (promoter never reaches `run-role.sh`). It will surface once the entrypoint is fixed. Worth fixing in the same pass.

## Risk

Low. This is a mechanical correctness fix — replacing a wrong path string with the correct one. The GIT_USER_NAME/GIT_USER_EMAIL fallbacks are overridden by docker-compose env vars (`GIT_USER_NAME: "Blackmarket Apparel Bot"`) so only the fallback strings change, not actual behavior. The fix unblocks all currently silently-broken roles.

## Verification

Read `entrypoint-worker.sh:27` → `/git-store/marineactivity.com`. Read `docker-compose.yml:45` → mount is `/git-store/blackmarketapparel.com`. Path mismatch confirmed. `run-deployer.sh:67` confirmed posts Slack on attempt cap.
