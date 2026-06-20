# The kill-switch invariant

The Cron Manager pauses a role by writing `ops/.<role>-disabled`. That flag does
nothing on its own — a site's shell scripts have to **check the flag and exit
early**. This file is the exact, copy-paste source of truth for those checks.

Two layers, both required on every site:

1. **`ops/scripts/run-worker.sh`** — runs in the **cron container**, spins the
   worker. Checking here is primary: it skips *before* paying for a worker
   container, and it's what the panel's instant-pause design relies on.
2. **`ops/scripts/run-role.sh`** — runs **inside the worker container**.
   Defense-in-depth: catches a role reached by a path that bypasses
   `run-worker.sh` (e.g. a direct `docker compose run --rm worker <role>`).

Both take effect on the next fire with **no rebuild** because the project is
bind-mounted into the cron/worker containers.

---

## Block for `run-worker.sh`

`run-worker.sh` computes the repo root from its own location. Insert the block
**right after the `ROLE` argument is validated** and **before** the
`docker image inspect` / `docker compose run` logic:

```bash
# Hard kill-switch: if ops/.<role>-disabled exists, no-op immediately WITHOUT
# spinning a worker container. Bind-mounted, so it takes effect on the next
# scheduled fire with no rebuild/restart. The cron-manager panel's enable/disable
# buttons toggle this same flag. Re-enable: rm ops/.<role>-disabled
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -f "$SCRIPT_DIR/ops/.${ROLE}-disabled" ]]; then
  echo "[$(date -Iseconds)] $ROLE is DISABLED (ops/.${ROLE}-disabled present) — skipping"
  exit 0
fi
```

`SCRIPT_DIR` resolves `ops/scripts/run-worker.sh` → repo root, so
`$SCRIPT_DIR/ops/.${ROLE}-disabled` is exactly where the panel writes the flag
(`opsDir/.${role}-disabled`).

## Block for `run-role.sh`

`run-role.sh` already defines `REPO_ROOT` (container-aware: `/work` inside the
worker, the host path otherwise). Insert the block **after `REPO_ROOT` and
`ROLE` are both set**, before the lock/`claude` logic — anchoring just before the
`ROLE_FILE=...` line works on every site:

```bash
# Kill-switch (defense-in-depth): honor ops/.<role>-disabled even if run-role.sh
# is reached by a path that bypasses run-worker.sh (e.g. a direct
# `docker compose run --rm worker <role>`). Mirrors run-worker.sh's check.
if [[ -f "$REPO_ROOT/ops/.${ROLE}-disabled" ]]; then
  echo "[$(date -Iseconds)] $ROLE is DISABLED (ops/.${ROLE}-disabled present) — skipping"
  exit 0
fi
```

---

## Verifying after you add it

```bash
bash .claude/skills/cron-manager-maintenance/scripts/verify-killswitch.sh
```

It static-greps both scripts, runs `bash -n`, then functionally proves: with a
temp flag present the script exits 0 with the `DISABLED` message *before any
docker call*; with no flag a bogus role advances past the kill-switch (no false
skip). Every site must come back all-green.

## Notes & gotchas

- **The flag path must match the panel.** Panel writes
  `<opsDir>/.<role>-disabled` where `opsDir = sites/<slug>/ops`. Both checks
  above resolve to that exact path. If you ever change the panel's flag path
  (`server.js` → `path.join(sys.opsDir, `.${role}-disabled`)`), change both
  scripts too.
- **Role name = whatever follows `run-worker.sh`.** The panel's `extractRole`
  (`crontab.js`) matches `/run-worker\.sh\s+([A-Za-z0-9._-]+)/`. The flag is
  keyed on that string, so a crontab line `run-worker.sh content-writer` →
  `.content-writer-disabled`. The deployer line
  `[ ! -f .deploy-needed ] || bash ops/scripts/run-worker.sh deployer` is still a
  proper role toggle (`role=deployer`).
- **Direct `docker compose run --rm worker <role>` lines** are NOT parsed as
  roles (no instant toggle). The `run-role.sh` layer still honors a matching
  flag, but for uniform pause behavior, route scheduled roles through
  `run-worker.sh`.
- **Per-site variations are fine.** Some `run-worker.sh` files add extra logic
  (sinderella brings up vLLM; aliencouncil adds a `timeout` guard and
  `ROLE_CONTEXT`). The kill-switch goes in the same spot regardless — right after
  the `ROLE` validation, before any docker work.
- **No rebuild needed** to deploy either change — bind-mounted. But commit +
  push for durability against fresh clones / worker-image rebuilds (one file,
  no `git add -A`).
