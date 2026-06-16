# WIRING.md — the archetype-agnostic install engine

This is the **one** mechanical procedure for installing ANY cron-role archetype
(`engineer`, `affiliate-editor`, `content-writer`, `planner`, `seo-analyst`, …) into a
portfolio site under `sites/<domain>/`. The per-archetype `domains-cron-role-<name>`
skill is a thin pointer — it tells you which archetype to install, then defers to this
document. Everything role-specific (schedule, model, scripts, placeholders, worker
deps, gitignore globs) is READ from the archetype's `meta.yml` at install time. **Never
hardcode one archetype's assumptions here.** Where a value below is shown for the
engineer, it is an EXAMPLE of how a field could be filled — not a default.

Companion files (all under `tools/cron-roles/`):
- `README.md` — the **stamp-once** model: this installer scaffolds a complete, working
  role and walks away. Installed role bodies are tuned per site and are NEVER re-synced.
- `validate-install.sh <site-dir> <role>` — the pass/fail gate. Step 11 MUST call it; a
  non-zero exit means the install is **not** done.
- `handoff-protocol.md` — how roles hand work to each other through the task board, and
  how to generate the per-role "awareness block" (referenced by Steps 4 and 10).
- `archetypes/<name>/` — `role.md.tmpl` (canonical body), `meta.yml` (knobs), `scripts/`.

---

## Maintain mode (read first)

If `$TARGET/ops/roles/<name>.md` **already exists**, this is a maintain pass, not a
fresh install. Run **only Steps 4, 10, and 11** — refresh the role body, refresh the
sibling/awareness stanzas, and re-verify. **Never destroy operator edits to an existing
role body**: stamp-once means installed bodies are tuned per site. In maintain mode,
overwrite only the regenerable regions (e.g. the `<!-- AWARENESS-BLOCK -->` span and any
heading the archetype declares as canonical-required); leave hand-written sections
intact. If you cannot refresh without clobbering operator prose, stop and report rather
than overwrite.

A fresh install runs all 13 steps in order.

---

## Step 1 — Confirm target & preconditions

The target follows the portfolio ops pattern, or we stop. Assert each of these exists;
if any is missing, the project doesn't follow the pattern — **stop and report exactly
what's absent**, do not improvise:

```bash
TARGET=<site-dir>   # e.g. /home/jesse/projects/domains/sites/<domain>

for f in \
  ops/scripts/run-role.sh ops/scripts/run-worker.sh ops/scripts/notify-slack.sh \
  ops/docker/crontab.docker ops/docker/Dockerfile.worker docker-compose.yml ; do
  [ -f "$TARGET/$f" ] || { echo "MISSING: $f"; exit 1; }
done

for d in ops/tasks/backlog ops/tasks/in-progress ops/tasks/done ; do
  [ -d "$TARGET/$d" ] || { echo "MISSING dir: $d"; exit 1; }
done

# A Slack channel var for this site must be present in the shared .env.
grep -qE 'SLACK_CHANNEL_\w+' /home/jesse/projects/domains/.env \
  || { echo "MISSING: SLACK_CHANNEL_* in /home/jesse/projects/domains/.env"; exit 1; }
```

---

## Step 2 — Detect project context

Resolve and record the substitution values the template needs. These are read from the
site, not invented:

```bash
SITE_NAME=$(grep -m1 '"name"' "$TARGET/site/package.json" | sed 's/.*": *"//;s/".*//'); [ -z "$SITE_NAME" ] && SITE_NAME=$(basename "$TARGET")
SITE_URL=$(grep -m1 -oP 'https://[^ )"]+' "$TARGET/CLAUDE.md" | head -1)
SLACK_ENV_VAR=$(grep -oP 'SLACK_CHANNEL_\w+' "$TARGET/ops/scripts/run-role.sh" | head -1)
SLACK_CHANNEL=$(grep -oP 'SLACK_CHANNEL_\w+:-\K[^}]+' "$TARGET/ops/scripts/run-role.sh" | head -1)
ls "$TARGET/site/src/content/"   # collections — for any render/marker placeholders the archetype declares
```

Record `SITE_NAME`, `SITE_URL`, `SLACK_ENV_VAR`, `SLACK_CHANNEL`, and the content
collection names. Any value the archetype's `meta.placeholders` references but you
cannot auto-detect → stop and ask, or report it for manual fill rather than guessing.

---

## Step 3 — Read the archetype

Load `tools/cron-roles/archetypes/<name>/meta.yml`. It supplies every role-specific knob
this procedure consumes. Read these fields and hold them for the steps below:

| Field | Used by | Meaning |
|---|---|---|
| `schedule` | Step 7 | cron expression (5-field) for `crontab.docker` |
| `model` | Step 6 | model id passed as `--model`, or `none` (role picks its own / is bash-driven) |
| `owns_task_types` | Step 12 | task `type:`/`assigned_role:` values this role picks up |
| `produces_task_types` | Step 10 | task types this role enqueues for siblings |
| `worker_deps` | Step 8 | extra Dockerfile.worker system/npm deps (may be empty) |
| `placeholders` | Step 4 | the `{{TOKEN}}` set to substitute in `role.md.tmpl` |
| `needs_rebuild_verify` | Step 11 | always true in practice; the crontab bake makes rebuild mandatory regardless |
| `scripts` | Step 5 | archetype scripts to stamp into `ops/scripts/` (may be empty) |
| `gitignore` | Step 9 | scratch globs this role writes that must be ignored (may be empty) |

If `meta.yml` is absent, the archetype is not ready to install — stop and report.

---

## Step 4 — Stamp the role file

Copy the canonical body and substitute every placeholder:

```bash
mkdir -p "$TARGET/ops/roles"
cp "tools/cron-roles/archetypes/<name>/role.md.tmpl" "$TARGET/ops/roles/<name>.md"
```

Then substitute **every** token named in `meta.placeholders` using the values from
Step 2 (e.g. `{{SITE_NAME}}`, `{{SITE_URL}}`, `{{SLACK_CHANNEL}}`, `{{SLACK_CHANNEL_ENV_VAR}}`,
plus any archetype-specific markers). After substitution there must be **zero** `{{…}}`
left — the validator's check-1 fails on any unresolved placeholder:

```bash
grep -n '{{' "$TARGET/ops/roles/<name>.md" && echo "UNRESOLVED placeholders — fix before continuing"
```

**Awareness section.** The template contains a `<!-- AWARENESS-BLOCK -->` marker.
Generate the dynamic awareness section by following `handoff-protocol.md`
("Generating the awareness block") — it produces, from the set of sibling roles already
installed on this site, the stanza that tells THIS role who else exists and how to hand
work to them. Replace the marker with that generated block.

In **maintain mode** this is the only body region you regenerate (plus the marker span);
leave operator-authored prose untouched.

---

## Step 5 — Stamp archetype scripts

Only if `meta.scripts` is non-empty. Copy each listed script from
`archetypes/<name>/scripts/` into `$TARGET/ops/scripts/`, substituting the same
placeholders from Step 2, then mark them executable:

```bash
# for each <script> in meta.scripts:
cp "tools/cron-roles/archetypes/<name>/scripts/<script>" "$TARGET/ops/scripts/<script>"
# …substitute placeholders…
chmod +x "$TARGET/ops/scripts/<script>"
```

If `meta.scripts` is empty (the archetype runs entirely through `claude -p` on the role
body, with no helper scripts), skip this step — that is normal for some archetypes.

---

## Step 6 — Wire `run-role.sh` — ARCHITECTURE-AWARE

Sites use **one of two dispatcher styles**. Detect which before touching the file:

```bash
grep -nE 'if \[\[ "\$ROLE" ==|elif \[\[ "\$ROLE" ==' "$TARGET/ops/scripts/run-role.sh"
```

**(a) Explicit per-role branches** (e.g. americastrikes: an `if/elif [[ "$ROLE" == "<x>" ]]; then … fi`
chain, one branch per role). Add a NEW branch following the file's exact existing style.

- If `meta.model == none` (bash-only roles that choose their model internally, e.g. the
  engineer, whose `run-engineer.sh` selects the model itself), pass **no** `--model`
  flag — dispatch straight to the role's runner / `claude -p` path the file uses:

  ```bash
  elif [[ "$ROLE" == "<name>" ]]; then
    set +e
    bash "$REPO_ROOT/ops/scripts/run-<name>.sh" "$LOG" 2>&1 | tee -a "$LOG"
    STATUS=$?
    set -e
  ```

- If `meta.model` is a real model id, match how the file passes models — typically a
  `MODEL=` entry in its per-role `case` plus `--model "$MODEL"` on the `claude -p` call.
  Add the role to that `case` with `MODEL="<meta.model>"`; do not bolt on a parallel
  mechanism.

**(b) Generic dispatcher** (no per-role branch — the file simply runs whatever
`ops/roles/<role>.md` exists on disk, parameterized by a `case`/lookup). **DO NOT
fabricate an elif chain.** The role is already dispatchable the moment its `<name>.md`
exists (Step 4). Instead, ensure any role-specific flags/allowlist entries the generic
path needs are present (e.g. a turn-budget/timeout/model entry in the generic `case`),
and note in the commit (Step 13) that the generic dispatcher already handles `<name>`.

**Either way**, after this step `validate-install.sh`'s check-2 (a dispatch branch /
matchable token for `<name>` in `run-role.sh`) must pass.

**Slack-notify allowlist — double-post guard.** Do **NOT** add a bash-only,
self-notifying role (one whose own script posts to Slack — e.g. the engineer's
`run-engineer.sh` posts every heartbeat itself) to `run-role.sh`'s Slack-notify
allowlist. The wrapper would then post a second message for the same run. Only add roles
to that allowlist when the role does NOT notify on its own.

---

## Step 7 — Wire `crontab.docker`

Append a schedule line invoking the role via the worker, with a short comment header.
**Idempotent** — skip if a line invoking `<name>` already exists:

```bash
CRON="$TARGET/ops/docker/crontab.docker"
if grep -qE "run-worker\.sh +<name>( |\$)" "$CRON"; then
  echo "crontab already has <name> — leaving as-is"
else
  cat >> "$CRON" <<EOF

# <Name> — <meta.schedule human note>
<meta.schedule>   bash ops/scripts/run-worker.sh <name>
EOF
fi
```

Use the archetype's `meta.schedule` verbatim for the cron expression (e.g. `0 */4 * * *`
for a 4-hourly role). The validator's check-3 requires a `run-worker.sh <name>` line.

---

## Step 8 — Wire `Dockerfile.worker`

**Only if `meta.worker_deps` is non-empty.** Most archetypes add nothing here and this
step is skipped. When the archetype needs extra runtime tooling, add it to
`ops/docker/Dockerfile.worker`.

Reference example (this is the **engineer's** worker-deps, shown to illustrate the
shape — substitute your archetype's actual `meta.worker_deps`):

```dockerfile
# (example: the engineer's true-render health check needs a headless browser)
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont

# Install the JS driver into a dedicated dir, pointed at Alpine's system chromium.
RUN mkdir -p /opt/engineer-tools && cd /opt/engineer-tools \
    && npm init -y >/dev/null 2>&1 \
    && npm install playwright-core@1.49.1
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_CORE_ENTRY=/opt/engineer-tools/node_modules/playwright-core/index.js
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

**Caveat (build-order):** install these deps **as root**, in a layer that runs BEFORE
the non-root runtime user is created. npm/apk output is world-readable, so the runtime
user can read it. Do **NOT** `chown` the install to the runtime user in a layer where
that user does not yet exist — the build fails. Place the `apk add` / install / `ENV`
block above the `adduser …` / `USER <runtime-user>` lines.

---

## Step 9 — Update `.gitignore`

Only if `meta.gitignore` is non-empty. The role's per-run scratch (logs, render dumps,
intermediate artifacts) must be ignored, or a `git add -A` fix-and-commit path commits
junk. Append each glob and confirm each is actually matched:

```bash
GI="$TARGET/.gitignore"
# for each <glob> in meta.gitignore:
grep -qxF "<glob>" "$GI" || echo "<glob>" >> "$GI"
git -C "$TARGET" check-ignore "<a sample path matching the glob>"   # must print the path → matched
```

If `git check-ignore` prints nothing for a sample path, the glob is wrong — fix it
before continuing.

---

## Step 10 — Sibling awareness

Make existing sibling roles aware of the newly installed role (and, where relevant, vice
versa). Follow `handoff-protocol.md` — append the **bidirectional awareness stanza** to
each existing sibling role file so they know this role exists and how to hand it work
(per `meta.owns_task_types` / `meta.produces_task_types`). **Idempotent**: skip any role
file that already contains the stanza heading. Do not append to pure-pipeline roles that
cannot self-escalate (handoff-protocol.md lists the exclusions).

---

## Step 11 — Rebuild + VERIFY (the sinderella guard)

`crontab.docker` is **baked into the cron image at build time** (the cron Dockerfile
`COPY`s it). A line added to `crontab.docker` after the last build is invisible to the
running container — this is exactly how sinderella.org had an engineer scheduled
`0 */4 * * *` that never ran for weeks. So the rebuild is **mandatory even for roles that
add no worker deps** (Step 8 skipped): the new crontab line still needs a fresh cron
image.

```bash
cd "$TARGET" && docker compose build worker cron && docker compose up -d cron
bash /home/jesse/projects/domains/tools/cron-roles/validate-install.sh "$TARGET" "<name>"
```

The validator's **live-container check is the gate**. A non-zero exit means the install
is **NOT done** — most often the image is stale (rebuild didn't take) or the dispatch /
crontab wiring is missing. Fix and re-run until it prints `PASS`. Do not declare done on
a `WARN` (cron container not running) either — bring the cron container up and re-verify.

---

## Step 12 — Dry run

Fire the role once, out of band, and confirm it actually works end-to-end:

```bash
cd "$TARGET" && bash ops/scripts/run-worker.sh <name>
```

Confirm all of:
- a Slack heartbeat / completion message landed in `$SLACK_CHANNEL`,
- a fresh `ops/logs/<name>-*.log` was written,
- `ops/board/last-run.json` has a `<name>` entry with a recent `at` and `exit: 0`.

Then seed **one throwaway typed task** matching `meta.owns_task_types` into
`ops/tasks/backlog/`, fire the role again, and confirm it (a) picks the task up and
(b) for any task that ships a code/content change, runs the build gate before committing.
Delete the throwaway task afterward.

---

## Step 13 — Commit

Commit the role body, any stamped scripts, the Dockerfile change, the crontab change,
the `.gitignore` change, and the board/last-run artifacts **together**. State in the
message that activation required the image rebuild from Step 11 (and, for a generic
dispatcher, note that no `run-role.sh` branch was needed because the generic path already
handles `<name>`):

```bash
cd "$TARGET"
git add ops/roles/<name>.md ops/scripts/ ops/docker/crontab.docker ops/docker/Dockerfile.worker .gitignore ops/board/last-run.json
git commit -m "<name>: install autonomous cron role (activation required cron-image rebuild)"
```
