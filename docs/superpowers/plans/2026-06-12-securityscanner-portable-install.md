# SecurityScanner Portable In-Project Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `vsec`/`security_v2` security dashboard into **SecurityScanner** — a portable scanner that installs *into* a consuming project (checked-in config in `SecurityScanner/`, gitignored runtime in `SecurityScanner/.runtime/`), runs on dynamic ports, fully self-contained, with config-as-source-of-truth and update-from-core.

**Architecture:** The engine stays `security_v2` (Python/FastAPI + Dockerized scanners). The Bash distribution CLI `vsec` is rebranded to `secscan` and gains an **in-project install layout** (replaces `~/.vsec/installs/`), bind-mounted runtime (replaces global named volumes), and two new subcommands: `init` (scaffold checked-in config) and `sync` (reconcile Projects/tool-targets/schedules from git-tracked YAML). Scanner containers already mount the target host-path directly via the host Docker daemon, so no repo-into-executor mount is needed; per-subtree scan scopes + a one-line `scanner.py` exclude keep recursive-tar structurally impossible.

**Tech Stack:** Bash (CLI + tests, plain-bash `assert_*` harness — no bats), Docker Compose v2, FastAPI (engine, untouched except one exclude constant), YAML/TOML config, GitHub Releases (image tarball distribution).

**Two repos involved:**
- **Core engine + CLI:** `/home/jesse/projects/aws-com-saas-product-infrastructure/security_v2` (git: `SynapticWorkshop/security_v2`). All CLI/engine/skill code changes happen here. **Work on branch `feat/secscan-in-project`.**
- **Consuming project (validation target):** `/home/jesse/projects/domains` — only receives the checked-in `SecurityScanner/` dir during validation (Phase F), via the skill.

**Reference spec:** `domains/docs/superpowers/specs/2026-06-12-securityscanner-portable-install-design.md`

---

## File Structure (what changes in `security_v2`)

| File | Responsibility | Action |
|------|----------------|--------|
| `bin/secscan` | The CLI (renamed from `bin/vsec`). Carries all subcommands. | Rename + heavy edits |
| `bin/vsec` | Back-compat shim that `exec`s `secscan` with a deprecation warning. | Create (thin) |
| `share/secscan/manifest.template.json` | Manifest template (renamed from `share/vsec/`). | Move |
| `share/secscan/compose.override.tmpl.yml` | New: template overlay that bind-mounts data + pins UID + sets ports. | Create |
| `share/secscan/secscan.toml.tmpl` | New: checked-in install config template. | Create |
| `share/secscan/schedules.yaml.tmpl` | New: schedules config template. | Create |
| `backend/executor/scanner.py:224-228` | `_SNAPSHOT_ALWAYS_EXCLUDE` — add `SecurityScanner`. | 1-line edit |
| `tests/secscan/*.sh` | Test harness (renamed from `tests/vsec/`) + new tests for in-project layout, init, sync. | Move + add |
| `.claude/commands/securityscanner-install.md` (in `~/.claude`) | New install skill (supersedes `skill-security_v2-install`). | Create |

**Naming conventions locked:** product `SecurityScanner`; CLI `secscan`; instance/prefix `secscan-<sanitized-project-basename>` (e.g. `secscan-domains`); checked-in dir `<project>/SecurityScanner/`; runtime `<project>/SecurityScanner/.runtime/`.

---

## Phase A — Rebrand `vsec` → `secscan`

Mechanical rename first so all later work happens against the new name. The rename is scripted, then verified by the existing test suite (renamed).

### Task A1: Branch + rename CLI and tests

**Files:**
- Create branch in `security_v2`
- Rename: `bin/vsec` → `bin/secscan`, `tests/vsec/` → `tests/secscan/`, `share/vsec/` → `share/secscan/`

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/jesse/projects/aws-com-saas-product-infrastructure/security_v2
git checkout main && git pull --ff-only
git checkout -b feat/secscan-in-project
```

- [ ] **Step 2: Move files with git (preserve history)**

```bash
git mv bin/vsec bin/secscan
git mv tests/vsec tests/secscan
git mv share/vsec share/secscan
git mv share/secscan/manifest.template.json share/secscan/manifest.template.json  # no-op, confirms path
ls bin/secscan tests/secscan share/secscan/manifest.template.json
```
Expected: all three paths listed, no error.

- [ ] **Step 3: Rebrand identifiers inside the CLI**

Apply these exact substitutions in `bin/secscan` (review each with `git diff` after):

```bash
cd /home/jesse/projects/aws-com-saas-product-infrastructure/security_v2
sed -i \
  -e 's/^VSEC_VERSION=/SECSCAN_VERSION=/' \
  -e 's/\bVSEC_VERSION\b/SECSCAN_VERSION/g' \
  -e 's/\[vsec\]/[secscan]/g' \
  -e 's#share/vsec#share/secscan#g' \
  -e 's#tests/vsec#tests/secscan#g' \
  bin/secscan
```
Then **manually** update the usage/help text (`cmd_help`, ~line 1508) and the header comment block (lines 1-11): every `vsec <subcommand>` example → `secscan <subcommand>`, and the one-line description. Do NOT change `VSEC_INSTALLS_ROOT` yet (Phase B replaces it wholesale) and do NOT change `derive_instance_name`'s `sec-` prefix yet (Task B1).

- [ ] **Step 4: Update the test harness sourcing + guard var**

In every `tests/secscan/*.sh`, the no-main guard `export VSEC_NO_MAIN=1` and `source .../bin/vsec` must point at the new name. Apply:

```bash
sed -i -e 's/VSEC_NO_MAIN/SECSCAN_NO_MAIN/g' -e 's#bin/vsec#bin/secscan#g' tests/secscan/*.sh
```
And in `bin/secscan`, rename the guard check (search for `VSEC_NO_MAIN`):
```bash
sed -i 's/VSEC_NO_MAIN/SECSCAN_NO_MAIN/g' bin/secscan
```

- [ ] **Step 5: Run the existing suite — must still pass after rename**

```bash
for t in tests/secscan/helpers_test.sh tests/secscan/build_test.sh; do echo "== $t =="; bash "$t"; done
```
Expected: each ends `Results: N passed, 0 failed`. (`install_test.sh`/`release_test.sh` may hit Phase-B-changed behavior; run them, note failures — they get fixed in Phase B. Helpers + build must be green now.)

- [ ] **Step 6: Create the `vsec` back-compat shim**

Create `bin/vsec`:
```bash
#!/usr/bin/env bash
# Deprecated: `vsec` was renamed to `secscan`. This shim forwards for muscle memory.
echo "[vsec] NOTE: 'vsec' is now 'secscan'. Forwarding…" >&2
exec "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/secscan" "$@"
```
```bash
chmod +x bin/vsec
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cli): rename vsec → secscan (+ back-compat shim), move tests/share

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase B — In-Project Install Layout

Replace the `~/.vsec/installs/<instance>` model with a fully in-project layout: config in `<project>/SecurityScanner/`, runtime in `<project>/SecurityScanner/.runtime/`, named volumes → bind-mounts, dynamic ports, prefix `secscan-<project>`.

### Task B1: New path/prefix derivation helpers (TDD)

**Files:**
- Modify: `bin/secscan` (helpers near lines 60-110)
- Test: `tests/secscan/layout_test.sh` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/secscan/layout_test.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
export SECSCAN_NO_MAIN=1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/bin/secscan"

PASS=0; FAIL=0
pass() { echo "  PASS  $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
assert_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (got '$1' want '$2')"; }
assert_match() { echo "$1" | grep -qE "$2" && pass "$3" || fail "$3 (got '$1')"; }

echo "==> instance_prefix derives secscan-<basename>"
assert_eq "$(instance_prefix /home/jesse/projects/domains)" "secscan-domains" "domains → secscan-domains"

echo "==> instance_prefix sanitizes + lowercases"
assert_eq "$(instance_prefix /tmp/My.Weird_Proj)" "secscan-my-weird-proj" "sanitized"

echo "==> config_dir_for / runtime_dir_for are in-project"
assert_eq "$(config_dir_for /home/jesse/projects/domains)" "/home/jesse/projects/domains/SecurityScanner" "config dir"
assert_eq "$(runtime_dir_for /home/jesse/projects/domains)" "/home/jesse/projects/domains/SecurityScanner/.runtime" "runtime dir"

echo "──────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bash tests/secscan/layout_test.sh`
Expected: FAIL — `instance_prefix: command not found` (function undefined).

- [ ] **Step 3: Implement the helpers**

In `bin/secscan`, replace `derive_instance_name()` (lines ~68-75) and `install_dir_for()` (lines ~77-85) with:
```bash
# Project-scoped prefix: secscan-<sanitized-basename>. Collisions across
# same-basename projects on one host are avoided by appending a short hash
# only when needed (see install conflict check).
instance_prefix() {
    local path real base
    real="$(realpath -m "$1")"
    base="$(basename "$real" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
    echo "secscan-${base}"
}

# Checked-in config dir (visible, committed).
config_dir_for() { echo "$(realpath -m "$1")/SecurityScanner"; }

# Gitignored runtime dir (generated + secret). The install *is* this dir.
runtime_dir_for() { echo "$(realpath -m "$1")/SecurityScanner/.runtime"; }
```
Delete `VSEC_INSTALLS_ROOT` (line 22), `write_pointer`, `read_pointer` (the install is now self-locating — no pointer file). Keep `find_free_port`.

- [ ] **Step 4: Run it — verify it passes**

Run: `bash tests/secscan/layout_test.sh`
Expected: `Results: 4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add bin/secscan tests/secscan/layout_test.sh
git commit -m "feat(secscan): in-project path/prefix helpers (config_dir/runtime_dir/instance_prefix)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task B2: Bind-mount + UID compose override template

**Files:**
- Create: `share/secscan/compose.override.tmpl.yml`

Named volumes (`postgres_data`, `redis_data`) become bind-mounts under `.runtime/data/` so deleting the project removes all data. Postgres/Redis tolerate an arbitrary UID when the data dir is pre-created and writable, so we pin `user: "${HOST_UID}:${HOST_GID}"` to prevent root-owned leftovers. **SonarQube is a documented exception** (its Elasticsearch index is UID-finicky): it keeps namespaced *named* volumes, removed explicitly by `secscan uninstall`.

- [ ] **Step 1: Create the template**

Create `share/secscan/compose.override.tmpl.yml`:
```yaml
# Generated by `secscan install` — DO NOT edit by hand (regenerated on upgrade).
# Overlays docker-compose.yml + docker-compose.images.yml to:
#  - bind-mount postgres/redis data into SecurityScanner/.runtime/data (containment)
#  - pin those containers to the host UID/GID (no root-owned files in the repo)
#  - keep SonarQube on a namespaced named volume (UID-finicky; uninstall purges it)
services:
  postgres:
    user: "__HOST_UID__:__HOST_GID__"
    volumes:
      - __RUNTIME_DIR__/data/postgres:/var/lib/postgresql/data
  redis:
    user: "__HOST_UID__:__HOST_GID__"
    volumes:
      - __RUNTIME_DIR__/data/redis:/data
  executor:
    volumes:
      - __RUNTIME_DIR__/temp-scans:/app/temp-scans:rw
```
(The `__PLACEHOLDER__` tokens are substituted at install time. `postgres_data`/`redis_data` named volumes are overridden away; SonarQube's named volumes are left intact from the base compose.)

- [ ] **Step 2: Commit**

```bash
git add share/secscan/compose.override.tmpl.yml
git commit -m "feat(secscan): bind-mount + UID-pin compose override template

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task B3: Rewrite `cmd_install` for the in-project layout

**Files:**
- Modify: `bin/secscan` `cmd_install` (lines ~398-738)
- Test: `tests/secscan/install_test.sh` (update existing)

- [ ] **Step 1: Update the install test expectations**

In `tests/secscan/install_test.sh`, find assertions referencing `~/.vsec/installs`, `.vsec` pointer, and `derive_instance_name`/`install_dir_for`. Replace them so the test (which runs with mocked `docker`/`curl`) asserts:
- config dir `"$PROJECT/SecurityScanner"` is created with `secscan.toml`, `manifest/install-manifest.json`, `.env.example`;
- runtime dir `"$PROJECT/SecurityScanner/.runtime"` is created with `.env` (mode 600), `data/postgres`, `data/redis`, `temp-scans/`, `compose.override.yml`;
- `.env` contains `INSTANCE_NAME=secscan-<basename>`, `HOST_TEMP_SCANS_PATH=$PROJECT/SecurityScanner/.runtime/temp-scans`, and dynamic `API_PORT`;
- the generated `compose.override.yml` has no `__PLACEHOLDER__` tokens left and references the runtime data dirs;
- `.gitignore` in the project gains a `SecurityScanner/.runtime/` line;
- **no** `.vsec` file is written.

Mirror the existing mock-docker pattern already in this file (it stubs `docker`/`curl` on PATH). Keep the plain-bash `assert_*` style.

- [ ] **Step 2: Run it — verify it fails**

Run: `bash tests/secscan/install_test.sh`
Expected: FAIL on the new assertions (old code still writes to `~/.vsec` + pointer).

- [ ] **Step 3: Rewrite `cmd_install`**

Edit `cmd_install` so its flow becomes (keep the existing release-download/checksum/image-load/health-poll blocks — only the *path* and *volume/env/override* logic changes):

1. Resolve target: `project_dir="$(realpath -m "${1:-$(pwd)}")"`, `prefix="$(instance_prefix "$project_dir")"`, `config_dir="$(config_dir_for "$project_dir")"`, `runtime_dir="$(runtime_dir_for "$project_dir")"`.
2. Conflict check: if containers named `${prefix}-*` exist for a *different* `project_dir`, append `-$(echo -n "$project_dir" | sha256sum | cut -c1-4)` to `prefix`. (Keeps multi-install isolation the old hash gave.)
3. `mkdir -p "$config_dir/manifest" "$runtime_dir"/data/{postgres,redis} "$runtime_dir/temp-scans"`.
4. Generate secrets (reuse existing `openssl rand` block).
5. Write `.env` to **`$runtime_dir/.env`** (chmod 600). Use `prefix` for `INSTANCE_NAME` and all `${prefix}-db`/`${prefix}-redis` DNS names, and these path keys:
   ```
   HOST_TEMP_SCANS_PATH=${runtime_dir}/temp-scans
   HOST_BACKEND_PATH=${runtime_dir}/backend
   ```
6. Copy `docker-compose.yml`, `docker-compose.images.yml`, `install-manifest.json` and extracted `backend/`+`config/` into **`$runtime_dir`** (not `~/.vsec`).
7. Render the override: read `share/secscan/compose.override.tmpl.yml`, substitute `__HOST_UID__`→`$(id -u)`, `__HOST_GID__`→`$(id -g)`, `__RUNTIME_DIR__`→`$runtime_dir`; write to `$runtime_dir/compose.override.yml`. Verify no `__` tokens remain (`! grep -q '__' "$runtime_dir/compose.override.yml"`).
8. Copy `.env.example` → `$config_dir/.env.example`; copy `manifest` → `$config_dir/manifest/install-manifest.json`; render `secscan.toml` (Task C1 template) → `$config_dir/secscan.toml`.
9. Ensure `.gitignore` in `project_dir` contains `SecurityScanner/.runtime/` (append if missing).
10. Start the stack from `$runtime_dir`:
    ```bash
    (cd "$runtime_dir" && docker compose --env-file .env \
        -f docker-compose.yml -f docker-compose.images.yml -f compose.override.yml up -d)
    ```
11. Health-poll on `$api_port` (reuse existing block).
12. Do **not** call `write_pointer`. Print next-steps: edit `SecurityScanner/projects/*.yaml`, then `secscan sync`.

- [ ] **Step 4: Run it — verify it passes**

Run: `bash tests/secscan/install_test.sh`
Expected: `Results: N passed, 0 failed`.

- [ ] **Step 5: Update `find_install_dir` + `cmd_status`/`list`/`uninstall`/`verify`/`upgrade` to the new layout**

These functions (lines ~750-1361) resolve the install via `~/.vsec` + `.vsec` pointer. Update `find_install_dir()` to: from the invocation dir (or `$1`), compute `runtime_dir_for` and use it if `SecurityScanner/.runtime/.env` exists; error otherwise. For `cmd_uninstall`, after `docker compose down`, also `docker volume rm ${prefix}-sonarqube-data ${prefix}-sonarqube-extensions ${prefix}-sonarqube-logs` (the documented SonarQube named-volume exception) and `rm -rf "$runtime_dir"`. Run a temp-owned bind dir as the host UID means `rm -rf` works without sudo; if any root-owned file slips in, clean via `docker run --rm -v "$runtime_dir":/x busybox rm -rf /x/data` before the host `rm`.

- [ ] **Step 6: Run the full suite + commit**

```bash
for t in tests/secscan/*.sh; do echo "== $t =="; bash "$t" || exit 1; done
git add -A
git commit -m "feat(secscan): in-project install layout (config + .runtime, bind-mounts, dynamic ports)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase C — `init` and `sync`

### Task C1: `secscan init` — scaffold checked-in config (TDD)

**Files:**
- Modify: `bin/secscan` (add `cmd_init`, wire into `main`)
- Create: `share/secscan/secscan.toml.tmpl`, `share/secscan/schedules.yaml.tmpl`
- Test: `tests/secscan/init_test.sh` (new)

- [ ] **Step 1: Create config templates**

`share/secscan/secscan.toml.tmpl`:
```toml
# SecurityScanner install config — checked in. Edited by humans.
[install]
instance = "__PREFIX__"
engine_version = "__VERSION__"
port_mode = "auto"          # auto = secscan picks free ports at install time

[scan]
# Scan scopes are ALWAYS subtrees, never "." (repo root) — see design §3.
# One file per target lives in projects/. Run `secscan sync` after editing.
```

`share/secscan/schedules.yaml.tmpl`:
```yaml
# Per-project scan cadence. `secscan sync` reconciles this into the engine.
defaults:
  cadence: weekly
projects: {}
```

- [ ] **Step 2: Write the failing test**

Create `tests/secscan/init_test.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
export SECSCAN_NO_MAIN=1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/bin/secscan"
PASS=0; FAIL=0
pass(){ echo "  PASS  $*"; PASS=$((PASS+1)); }
fail(){ echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
assert_file(){ [ -f "$1" ] && pass "$2" || fail "$2 (missing $1)"; }
assert_grep(){ grep -qF "$2" "$1" && pass "$3" || fail "$3"; }

proj="$(mktemp -d)"
cmd_init "$proj"
assert_file "$proj/SecurityScanner/secscan.toml" "secscan.toml created"
assert_file "$proj/SecurityScanner/schedules.yaml" "schedules.yaml created"
[ -d "$proj/SecurityScanner/projects" ] && pass "projects/ created" || fail "projects/ created"
assert_grep "$proj/SecurityScanner/secscan.toml" "secscan-$(basename "$proj")" "toml has prefix"
assert_grep "$proj/.gitignore" "SecurityScanner/.runtime/" "gitignore updated"
! grep -q '__' "$proj/SecurityScanner/secscan.toml" && pass "no placeholders left" || fail "placeholders remain"
rm -rf "$proj"
echo "Results: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 3: Run it — verify it fails**

Run: `bash tests/secscan/init_test.sh` → FAIL (`cmd_init: command not found`).

- [ ] **Step 4: Implement `cmd_init`**

Add to `bin/secscan`:
```bash
cmd_init() {
    local project_dir prefix config_dir version
    project_dir="$(realpath -m "${1:-$(pwd)}")"
    prefix="$(instance_prefix "$project_dir")"
    config_dir="$(config_dir_for "$project_dir")"
    version="${SECSCAN_ENGINE_VERSION:-unset}"
    mkdir -p "$config_dir/projects" "$config_dir/manifest"
    sed -e "s/__PREFIX__/${prefix}/g" -e "s/__VERSION__/${version}/g" \
        "$REPO_ROOT/share/secscan/secscan.toml.tmpl" > "$config_dir/secscan.toml"
    cp "$REPO_ROOT/share/secscan/schedules.yaml.tmpl" "$config_dir/schedules.yaml"
    local gi="$project_dir/.gitignore"
    grep -qxF 'SecurityScanner/.runtime/' "$gi" 2>/dev/null || echo 'SecurityScanner/.runtime/' >> "$gi"
    info "Initialized SecurityScanner config at $config_dir"
}
```
Wire into `main()` dispatch: `init) cmd_init "$@" ;;`.

- [ ] **Step 5: Run it — verify it passes**

Run: `bash tests/secscan/init_test.sh` → `Results: 6 passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add bin/secscan tests/secscan/init_test.sh share/secscan/secscan.toml.tmpl share/secscan/schedules.yaml.tmpl
git commit -m "feat(secscan): add 'init' — scaffold checked-in SecurityScanner/ config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task C2: `secscan sync` — reconcile config → engine (TDD)

**Files:**
- Modify: `bin/secscan` (add `cmd_sync`, `api_call` helper, `tool_id_for` helper)
- Test: `tests/secscan/sync_test.sh` (new, against a mocked API)

`sync` reads `SecurityScanner/projects/*.yaml` + `schedules.yaml`, then for each project: ensures a Project exists (`GET /api/v2/projects` → match by name → `POST` or `PUT`), sets `base_path`=repo root and the project's `scope` as the scan path, attaches tool-targets (`POST /api/v2/tool-targets/bulk`), and creates schedules (`POST /api/v2/schedules`). Idempotent: existing items are updated, not duplicated.

- [ ] **Step 1: Write the failing test** (mock `curl` to record calls)

Create `tests/secscan/sync_test.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
export SECSCAN_NO_MAIN=1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/bin/secscan"
PASS=0; FAIL=0
pass(){ echo "  PASS  $*"; PASS=$((PASS+1)); }
fail(){ echo "  FAIL  $*"; FAIL=$((FAIL+1)); }

# Mock api_call: record method+path+body to $CALLS, return canned JSON.
CALLS="$(mktemp)"
api_call() { echo "$1 $2 ${4:-}" >> "$CALLS"
  case "$2" in
    /api/v2/projects) echo '[]' ;;                       # no existing projects
    /api/v2/tools) echo '[{"id":7,"name":"semgrep"},{"id":3,"name":"gitleaks"}]' ;;
    *) echo '{"id":1}' ;;
  esac; }
export -f api_call 2>/dev/null || true

proj="$(mktemp -d)"; mkdir -p "$proj/SecurityScanner/projects" "$proj/sites/foo.com"
cat > "$proj/SecurityScanner/projects/foo.com.yaml" <<YAML
name: foo.com
scope: sites/foo.com
scanners: [semgrep, gitleaks]
YAML
cat > "$proj/SecurityScanner/schedules.yaml" <<YAML
defaults: { cadence: weekly }
projects: { foo.com: { cadence: weekly } }
YAML

cmd_sync "$proj"
grep -q 'POST /api/v2/projects' "$CALLS" && pass "creates project" || fail "creates project"
grep -q '/tool-targets/bulk' "$CALLS" && pass "bulk tool-targets" || fail "bulk tool-targets"
grep -q 'POST /api/v2/schedules' "$CALLS" && pass "creates schedule" || fail "creates schedule"
rm -rf "$proj" "$CALLS"
echo "Results: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bash tests/secscan/sync_test.sh` → FAIL (`cmd_sync: command not found`).

- [ ] **Step 3: Implement `api_call`, `tool_id_for`, `cmd_sync`**

Add to `bin/secscan` (parses YAML with a small `python3` helper — already a dependency):
```bash
# api_call <METHOD> <PATH> [-d] <BODY?> — talks to the running engine API.
api_call() {
    local method="$1" path="$2" body="${4:-}"
    local base="http://localhost:$(read_env_var API_PORT)"
    if [ -n "$body" ]; then
        curl -sf -X "$method" "$base$path" -H 'Content-Type: application/json' -d "$body"
    else
        curl -sf -X "$method" "$base$path"
    fi
}

tool_id_for() {  # <name> — map scanner name → tool id via GET /tools
    local name="$1"
    api_call GET /api/v2/tools | python3 -c \
      "import sys,json;ts=json.load(sys.stdin);print(next((t['id'] for t in ts if t['name']=='$name'),''))"
}

cadence_for() {  # <project_name> from schedules.yaml → frequency string
    local proj="$1" file="$2"
    python3 -c "import sys,yaml;d=yaml.safe_load(open('$file'));p=d.get('projects',{}).get('$proj',{});print(p.get('cadence',d.get('defaults',{}).get('cadence','weekly')))"
}

cmd_sync() {
    local project_dir config_dir
    project_dir="$(realpath -m "${1:-$(pwd)}")"
    config_dir="$(config_dir_for "$project_dir")"
    [ -d "$config_dir/projects" ] || die "no SecurityScanner/projects/ — run 'secscan init' first"
    local sched="$config_dir/schedules.yaml"
    local existing; existing="$(api_call GET /api/v2/projects)"
    for pf in "$config_dir"/projects/*.yaml; do
        [ -e "$pf" ] || continue
        local name scope; name="$(python3 -c "import yaml;print(yaml.safe_load(open('$pf'))['name'])")"
        scope="$(python3 -c "import yaml;print(yaml.safe_load(open('$pf'))['scope'])")"
        [ "$scope" = "." ] && die "scope '.' (repo root) is forbidden in $pf — use a subtree"
        local pid
        pid="$(echo "$existing" | python3 -c "import sys,json;ps=json.load(sys.stdin);print(next((p['id'] for p in ps if p['name']=='$name'),''))")"
        local payload
        payload="$(python3 -c "import json;print(json.dumps({'name':'$name','base_path':'$project_dir','path':'$project_dir/$scope','language':'auto'}))")"
        if [ -z "$pid" ]; then
            pid="$(api_call POST /api/v2/projects -d "$payload" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
            info "created project $name (id $pid)"
        else
            api_call PUT "/api/v2/projects/$pid" -d "$payload" >/dev/null; info "updated project $name (id $pid)"
        fi
        # tool-targets (bulk) + schedules per scanner
        local scanners; scanners="$(python3 -c "import yaml;print(' '.join(yaml.safe_load(open('$pf')).get('scanners',[])))")"
        local targets="[]" freq; freq="$(cadence_for "$name" "$sched")"
        for s in $scanners; do
            local tid; tid="$(tool_id_for "$s")"; [ -z "$tid" ] && { warn "unknown scanner $s"; continue; }
            targets="$(python3 -c "import json,sys;t=json.loads('$targets');t.append({'tool_id':int('$tid'),'target_type':'path','target_value':'$scope','is_enabled':True,'config':{}});print(json.dumps(t))")"
            api_call POST /api/v2/schedules -d "$(python3 -c "import json;print(json.dumps({'project_id':int('$pid'),'tool_id':int('$tid'),'name':'$s - $name','frequency':'$freq','priority':50,'is_enabled':True}))")" >/dev/null || true
        done
        api_call POST /api/v2/tool-targets/bulk -d "$(python3 -c "import json;print(json.dumps({'project_id':int('$pid'),'targets':json.loads('$targets')}))")" >/dev/null || true
    done
    info "sync complete"
}
```
Wire into `main()`: `sync) cmd_sync "$@" ;;`. Add `pyyaml` to the install prerequisites note (most systems have it; if not, `pip install pyyaml` or fall back to a bundled mini-parser — document in README).

- [ ] **Step 4: Run it — verify it passes**

Run: `bash tests/secscan/sync_test.sh` → `Results: 3 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add bin/secscan tests/secscan/sync_test.sh
git commit -m "feat(secscan): add 'sync' — reconcile projects/tool-targets/schedules from checked-in YAML

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase D — Engine-side recursion-guard rename

### Task D1: Add `SecurityScanner` to the snapshot exclude list

**Files:**
- Modify: `backend/executor/scanner.py:224-228`

- [ ] **Step 1: Edit the constant**

Change `_SNAPSHOT_ALWAYS_EXCLUDE` (line 224) to:
```python
        _SNAPSHOT_ALWAYS_EXCLUDE = [
            "SecurityScanner",      # secscan in-project install dir (contains .runtime/temp-scans)
            ".security-dashboard",  # legacy vsec install dir
            "temp-scans",           # snapshot working dir (recursion vector)
            ".git",
        ]
```

- [ ] **Step 2: Verify the engine test suite still passes for the executor**

Run: `cd /home/jesse/projects/aws-com-saas-product-infrastructure/security_v2 && python3 -m pytest backend/tests -k "snapshot or scanner" -q` (if a venv is required, use the repo's documented test invocation in `CLAUDE.md`).
Expected: no new failures vs. baseline. If the suite can't run locally, at minimum `python3 -c "import ast; ast.parse(open('backend/executor/scanner.py').read())"` must succeed.

- [ ] **Step 3: Commit**

```bash
git add backend/executor/scanner.py
git commit -m "fix(executor): exclude SecurityScanner/ from source snapshots (recursion guard)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase E — Install Skill

### Task E1: Write `securityscanner-install` skill

**Files:**
- Create: `~/.claude/commands/securityscanner-install.md`
- (Leave the old `skill-security_v2-install.md` in place but add a one-line deprecation banner pointing to the new skill.)

- [ ] **Step 1: Author the skill**

Create `~/.claude/commands/securityscanner-install.md` with frontmatter and an autonomous-install body. Required behavior (write each as explicit numbered phases in the skill, mirroring the proven structure of the existing `skill-security_v2-install.md`):
- **Frontmatter:** `description: "Install SecurityScanner (secscan) into a project: scaffold checked-in config, enumerate scan targets, install the engine on dynamic ports, sync projects + schedules, validate scans fire."`, `allowed-tools: Bash, Read, Write, Edit, Grep, Glob, TodoWrite`.
- **Phase 0 — locate CLI:** ensure `secscan` is on PATH (symlink `~/.local/bin/secscan` → `security_v2/bin/secscan`), pick the engine version (latest GitHub release tag).
- **Phase 1 — `secscan init <project>`**, then enumerate scan targets: for `domains`, one `projects/<domain>.yaml` per `sites/*` dir (scope `sites/<domain>`, auto-detect `languages`/`scanners`) + `tools.yaml` (scope `tools/`). Generic projects: detect top-level code areas and propose project files. **Never** create a project with scope `.`.
- **Phase 2 — `secscan install <project>`** (dynamic ports, in-project runtime). Verify health endpoint.
- **Phase 3 — set `schedules.yaml`** (tools daily, sites weekly) then `secscan sync <project>`.
- **Phase 4 — validate:** `secscan status`; trigger one smoke scan (`POST /api/v2/scans` for one project+tool) and confirm it returns findings; confirm `SecurityScanner/.runtime/` is gitignored and `SecurityScanner/` is staged (config only — no `.env`, no `data/` in `git status`).
- **Phase 5 — report:** print ports, dashboard URL, projects created, next-steps.

- [ ] **Step 2: Lint the skill frontmatter**

Run: `head -5 ~/.claude/commands/securityscanner-install.md` and confirm valid YAML frontmatter (opening `---`, `description:`, `allowed-tools:`, closing `---`).

- [ ] **Step 3: Add deprecation banner to the old skill**

Prepend to `~/.claude/commands/skill-security_v2-install.md` body: `> **DEPRECATED:** use \`/securityscanner-install\` (secscan, in-project layout). This v2/~.vsec installer is retained for reference only.`

- [ ] **Step 4: Commit** (the skill lives in `~/.claude`, outside the repo — note it in the repo's `docs/` changelog instead)

Append a line to `security_v2/docs/PORTING_LOG.md` (or create `docs/CHANGELOG-secscan.md`): "Added securityscanner-install skill (~/.claude/commands/)." Commit that doc:
```bash
git add docs/
git commit -m "docs(secscan): record securityscanner-install skill addition

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase F — Validation

### Task F1: Clean install into `domains/`

- [ ] **Step 1: Build/obtain an engine release** (if no release exists for the pinned version)

```bash
cd /home/jesse/projects/aws-com-saas-product-infrastructure/security_v2
./bin/secscan build "$(cat docs/.next-version 2>/dev/null || echo v0.4.0)"   # or use existing v0.3.x release
```

- [ ] **Step 2: Tear down the old `~/.vsec` install (non-production)**

```bash
secscan uninstall || true
# remove the stale pointer + old install root
rm -f /home/jesse/projects/domains/.vsec
rm -rf /home/jesse/.vsec/installs/sec-c04d85
```

- [ ] **Step 3: Run the skill against domains**

In a Claude session at `/home/jesse/projects/domains`: invoke `/securityscanner-install`. Let it init → install → sync.

- [ ] **Step 4: Verify the install**

```bash
cd /home/jesse/projects/domains
test -f SecurityScanner/secscan.toml && echo OK-config
test -d SecurityScanner/.runtime/data/postgres && echo OK-runtime
git status --porcelain SecurityScanner/ | grep -v '.runtime/' | head   # only config staged
git check-ignore SecurityScanner/.runtime/.env && echo OK-gitignored
secscan status
ls SecurityScanner/projects/ | wc -l   # == count of sites/* + 1 (tools)
```
Expected: config present, runtime present + gitignored, project count matches, `secscan status` healthy on dynamic ports.

- [ ] **Step 5: Smoke scan + recursion check**

Trigger one scan for the `tools` project via the dashboard/API; confirm it completes and that no `source-snapshot/source-snapshot` recursion or `SecurityScanner/` self-inclusion occurred (check `SecurityScanner/.runtime/temp-scans/` stays bounded).

- [ ] **Step 6: Commit the domains config**

```bash
cd /home/jesse/projects/domains
git add SecurityScanner/ .gitignore
git commit -m "chore: add SecurityScanner in-project install config (secscan)"
```
(On the existing `feat/securityscanner-portable-install` branch in the domains repo.)

### Task F2: Portability test — second, unrelated project

- [ ] **Step 1: Install into a different project**

Pick `/home/jesse/projects/wootTracker` (or `worldmonitor`). Run `/securityscanner-install` there.

- [ ] **Step 2: Verify two isolated installs coexist**

```bash
docker ps --format '{{.Names}}' | grep -E 'secscan-(domains|woottracker)' | sort
secscan list   # both installs, different ports, different prefixes
```
Expected: both stacks running, distinct `secscan-<project>-*` names, distinct ports, no container hijack.

- [ ] **Step 3: Confirm containment**

```bash
ls /home/jesse/projects/wootTracker/SecurityScanner/.runtime/data/postgres >/dev/null && echo "data is in-project"
test ! -d /home/jesse/.vsec && echo "no ~/.vsec created"
```

### Task F3: Upgrade round-trip

- [ ] **Step 1: Cut a new engine release in core**

```bash
cd /home/jesse/projects/aws-com-saas-product-infrastructure/security_v2
./bin/secscan build v0.4.1 && ./bin/secscan release v0.4.1   # or bump appropriately
```

- [ ] **Step 2: Upgrade the domains install, retaining data**

```bash
cd /home/jesse/projects/domains
secscan upgrade v0.4.1
```

- [ ] **Step 3: Verify data + config survived**

```bash
secscan status   # new version, same ports
# scan history + projects still present (query API): GET /api/v2/projects returns the same set
secscan verify   # manifest SHAs + health green
```
Expected: version bumped, `SecurityScanner/.runtime/data/` preserved, projects/schedules intact, `secscan verify` passes.

- [ ] **Step 4: Merge**

When all three validation tasks pass, finish the branches via `superpowers:finishing-a-development-branch` (PRs to `SynapticWorkshop/security_v2` and to the domains repo).

---

## Self-Review Notes (coverage check)

- Spec §2 layout → Tasks B1, B3, C1. Spec §3 recursive-tar → B3 (scope-`.` guard in sync), D1 (exclude). Spec §4 CLI surface → A1 (rename), B3 (install), C1 (init), C2 (sync); status/list/uninstall/verify/upgrade updated in B3 Step 5. Spec §5 config schema → C1/C2 (projects/*.yaml, schedules.yaml). Spec §6 update-from-core → F3 (upgrade round-trip; `cmd_upgrade` reused). Spec §7 skill → E1. Spec §8 caveats: bind-mount UID → B2 + B3; existing-install migration → F1 Step 2; rename surface → A1. Spec §9 validation → F1/F2/F3.
- **Known follow-ups (not blocking):** the `cmd_upgrade`/`cmd_verify` bodies (lines ~1032-1361) still assume `~/.vsec`; B3 Step 5 covers redirecting `find_install_dir`, but a focused pass on each may surface stragglers — run `grep -n 'VSEC_INSTALLS_ROOT\|\.vsec\|write_pointer\|read_pointer\|install_dir_for\|derive_instance_name' bin/secscan` after Phase C and fix any remaining references before F1.
