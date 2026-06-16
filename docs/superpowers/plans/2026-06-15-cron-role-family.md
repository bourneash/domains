# Cron-Role Skill Family Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a family of `domains-cron-role-*` installer skills, one per role archetype, over a single shared wiring engine, so any standard autonomous role can be stamped into any portfolio site — un-aligned, stamp-once, with dynamic capability-based handoff.

**Architecture:** A version-controlled library at `tools/cron-roles/` holds the mechanical engine (`WIRING.md`), the handoff protocol, a runnable install validator, and one `archetypes/<name>/` folder per role (canonical body template + `meta.yml` + any scripts). Each thin skill `.claude/skills/domains-cron-role-<name>/SKILL.md` defers all mechanical steps to `WIRING.md` and supplies only its archetype's specifics. The first archetype (engineer) is selected from `americastrikes.com` and consolidates the two existing engineer skills; later archetypes are selected by comparing live copies against a fixed selection bar.

**Tech Stack:** Bash, Markdown skills, YAML front-matter, Docker Compose (cron + worker containers), Astro 5 + Cloudflare Workers sites, `claude -p` headless roles, Slack notify, file-based task board.

**Spec:** `docs/superpowers/specs/2026-06-15-cron-role-family-design.md`

---

## File Structure

**Created (library — the deliverable engine):**
- `tools/cron-roles/README.md` — what the library is, how skills consume it
- `tools/cron-roles/WIRING.md` — the mechanical install procedure (single source)
- `tools/cron-roles/handoff-protocol.md` — canonical task-board handoff edges + fallback
- `tools/cron-roles/validate-install.sh` — runnable pass/fail gate for any install
- `tools/cron-roles/archetypes/engineer/{role.md.tmpl,meta.yml,scripts/*}`
- `tools/cron-roles/archetypes/affiliate-editor/{role.md.tmpl,meta.yml}`
- `tools/cron-roles/archetypes/content-writer/{role.md.tmpl,meta.yml}`
- `tools/cron-roles/archetypes/planner/{role.md.tmpl,meta.yml}`
- `tools/cron-roles/archetypes/seo-analyst/{role.md.tmpl,meta.yml}`

**Created (skills — thin pointers):**
- `.claude/skills/domains-cron-role-engineer/SKILL.md`
- `.claude/skills/domains-cron-role-affiliate-editor/SKILL.md`
- `.claude/skills/domains-cron-role-content-writer/SKILL.md`
- `.claude/skills/domains-cron-role-planner/SKILL.md`
- `.claude/skills/domains-cron-role-seo-analyst/SKILL.md`

**Removed (after engineer consolidation validates):**
- `.claude/skills/domains-agent-cron-role-engineer/` (project-local, superseded)
- `/home/jesse/.claude/skills/skill-domain-add-engineer-role/` (global, superseded)

**Touched at install time (per target site, by WIRING.md — not by this plan directly):**
- `<site>/ops/roles/<name>.md`, sibling `ops/roles/*.md`
- `<site>/ops/scripts/run-role.sh`, `<site>/ops/docker/{crontab.docker,Dockerfile.worker}`
- `<site>/.gitignore`, `<site>/ops/board/<name>-log.md`

---

## Phase 0 — The engine + engineer (proves the pattern)

### Task 1: Library skeleton + README

**Files:**
- Create: `tools/cron-roles/README.md`

- [ ] **Step 1: Create the library directory tree**

```bash
cd /home/jesse/projects/domains
mkdir -p tools/cron-roles/archetypes/{engineer/scripts,affiliate-editor,content-writer,planner,seo-analyst}
```

- [ ] **Step 2: Write `tools/cron-roles/README.md`**

````markdown
# cron-roles — the portfolio's reusable autonomous-role library

One folder per role archetype. Each `domains-cron-role-<name>` skill is a thin
pointer that runs `WIRING.md` against a target site, using the archetype's
`role.md.tmpl` + `meta.yml` (+ any `scripts/`).

- `WIRING.md` — the mechanical install procedure. ONE copy. Skills never inline it.
- `handoff-protocol.md` — how roles hand work to each other through the task board.
- `validate-install.sh` — pass/fail gate; run after every install.
- `archetypes/<name>/` — `role.md.tmpl` (canonical body), `meta.yml` (knobs), `scripts/`.

Model: **stamp-once**. The installer scaffolds a complete, working role and walks
away. Installed role bodies are tuned per site and are never re-synced. Improving
an archetype here does NOT propagate to already-installed sites.

Non-goal: normalizing the roles already live on existing sites.
````

- [ ] **Step 3: Commit**

```bash
git add tools/cron-roles/README.md
git commit -m "feat(cron-roles): library skeleton + README"
```

---

### Task 2: The install validator (the test gate, built first)

**Files:**
- Create: `tools/cron-roles/validate-install.sh`

- [ ] **Step 1: Write the validator**

It is the pass/fail gate used by every install task below. It takes a site dir
and a role name and asserts the install is real and complete.

```bash
#!/usr/bin/env bash
# validate-install.sh <site-dir> <role-name>
# Asserts a cron role is fully + correctly installed. Exit 0 = pass, non-0 = fail.
set -uo pipefail

SITE="${1:?usage: validate-install.sh <site-dir> <role-name>}"
ROLE="${2:?usage: validate-install.sh <site-dir> <role-name>}"
fail() { echo "FAIL: $*" >&2; exit 1; }

ROLE_FILE="$SITE/ops/roles/$ROLE.md"
[ -f "$ROLE_FILE" ] || fail "role file missing: $ROLE_FILE"

# 1. No unresolved placeholders anywhere in the stamped role file.
if grep -q '{{' "$ROLE_FILE"; then
  fail "unresolved {{placeholder}} in $ROLE_FILE"
fi

# 2. run-role.sh has a dispatch branch for this role.
grep -q "\"$ROLE\"" "$SITE/ops/scripts/run-role.sh" \
  || fail "no dispatch branch for '$ROLE' in run-role.sh"

# 3. crontab.docker has a schedule line invoking this role.
grep -qE "run-worker\.sh +$ROLE( |\$)" "$SITE/ops/docker/crontab.docker" \
  || fail "no crontab line for '$ROLE' in crontab.docker"

# 4. The running cron container actually has the line (the sinderella guard).
#    Skipped with a loud warning if docker or the container is unavailable.
CRON_CTR="$(cd "$SITE" && docker compose ps -q cron 2>/dev/null)"
if [ -n "$CRON_CTR" ]; then
  docker exec "$CRON_CTR" crontab -l 2>/dev/null | grep -q "$ROLE" \
    || docker exec "$CRON_CTR" sh -c 'cat /etc/*crontab* /app/crontab* 2>/dev/null' \
       | grep -q "$ROLE" \
    || fail "cron container is live but '$ROLE' line is NOT in it — image is stale, rebuild did not take"
else
  echo "WARN: cron container not running for $SITE — skipped live-container check (rebuild+verify before declaring done)"
fi

echo "PASS: $ROLE installed in $SITE"
```

- [ ] **Step 2: Make it executable and verify it FAILS on a site without the role**

```bash
chmod +x tools/cron-roles/validate-install.sh
bash tools/cron-roles/validate-install.sh sites/reviewtattoo.com engineer; echo "exit=$?"
```

Expected: `FAIL: role file missing: sites/reviewtattoo.com/ops/roles/engineer.md` and `exit=1`. (reviewtattoo deliberately has no engineer.)

- [ ] **Step 3: Verify it PASSES on a site that already runs the role**

```bash
bash tools/cron-roles/validate-install.sh sites/wetpages.com engineer; echo "exit=$?"
```

Expected: `PASS: wetpages.com` (or a `WARN` about the container if its stack isn't up, still exit 0) and `exit=0`. If it fails on placeholder/dispatch/crontab checks, the validator's matchers are wrong — fix them against the known-good wetpages install before proceeding.

- [ ] **Step 4: Commit**

```bash
git add tools/cron-roles/validate-install.sh
git commit -m "feat(cron-roles): install validator (pass/fail gate, incl. sinderella live-container guard)"
```

---

### Task 3: Extract `WIRING.md` (the mechanical engine)

**Files:**
- Create: `tools/cron-roles/WIRING.md`
- Read for source: `/home/jesse/.claude/skills/skill-domain-add-engineer-role/SKILL.md`, `.claude/skills/domains-agent-cron-role-engineer/SKILL.md`

- [ ] **Step 1: Author `WIRING.md` as the archetype-agnostic procedure**

Lift the proven steps from the engineer skill, generalizing every engineer-specific bit to read from the archetype's `meta.yml`. The document MUST contain these numbered sections, each with concrete commands:

1. **Confirm target & preconditions** — assert these exist, else stop and report:
   `ops/scripts/{run-role,run-worker,notify-slack}.sh`, `ops/docker/{crontab.docker,Dockerfile.worker}`, `docker-compose.yml`, `ops/tasks/{backlog,in-progress,done}/`, and a `SLACK_CHANNEL_*` var in `/home/jesse/projects/domains/.env`.
2. **Detect project context** — resolve and record the substitution values:
   ```bash
   TARGET=<site-dir>
   SITE_NAME=$(grep -m1 '"name"' "$TARGET/site/package.json" | sed 's/.*": *"//;s/".*//'); [ -z "$SITE_NAME" ] && SITE_NAME=$(basename "$TARGET")
   SITE_URL=$(grep -m1 -oP 'https://[^ )"]+' "$TARGET/CLAUDE.md" | head -1)
   SLACK_ENV_VAR=$(grep -oP 'SLACK_CHANNEL_\w+' "$TARGET/ops/scripts/run-role.sh" | head -1)
   SLACK_CHANNEL=$(grep -oP 'SLACK_CHANNEL_\w+:-\K[^}]+' "$TARGET/ops/scripts/run-role.sh" | head -1)
   ls "$TARGET/site/src/content/"   # collections for render/markers
   ```
3. **Read the archetype** — `meta.yml` fields: `schedule`, `model`, `owns_task_types`, `produces_task_types`, `worker_deps`, `placeholders`, `needs_rebuild_verify`.
4. **Stamp the role file** — copy `archetypes/<name>/role.md.tmpl` → `$TARGET/ops/roles/<name>.md`; substitute every placeholder; generate the dynamic awareness section (call into `handoff-protocol.md`, Section "Generating the awareness block").
5. **Stamp archetype scripts** (if `archetypes/<name>/scripts/` non-empty) into `ops/scripts/` and `chmod +x`.
6. **Wire `run-role.sh`** — add a dispatch branch; pass `--model <model>` only if `meta.model != none`. Show the exact `elif [[ "$ROLE" == "<name>" ]]; then … fi` block. Do NOT add bash-only self-notifying roles to the Slack-notify allowlist (double-post guard — call it out).
7. **Wire `crontab.docker`** — append `<schedule>   bash ops/scripts/run-worker.sh <name>` with a comment header; idempotent (skip if a line for `<name>` already exists).
8. **Wire `Dockerfile.worker`** — only if `worker_deps` is non-empty; show the engineer example (chromium + playwright-core) as the reference and the "install as root / don't chown before the user exists" caveat.
9. **Update `.gitignore`** — add any scratch globs the archetype's scripts emit; `git check-ignore` each to confirm.
10. **Sibling awareness** — per `handoff-protocol.md`, append the bidirectional awareness stanza to existing siblings; idempotent.
11. **Rebuild + VERIFY (sinderella guard)** —
    ```bash
    cd "$TARGET" && docker compose build worker cron && docker compose up -d cron
    bash /home/jesse/projects/domains/tools/cron-roles/validate-install.sh "$TARGET" "<name>"
    ```
    The validator's live-container check is the gate. A non-zero exit means NOT done.
12. **Dry run** — `bash ops/scripts/run-worker.sh <name>`; confirm Slack heartbeat + `ops/logs/<name>-*.log` + `ops/board/last-run.json` entry; seed one throwaway typed task and confirm pickup + build-gate.
13. **Commit** — role/scripts/Dockerfile/crontab/board log together; note that activation required the image rebuild (Step 11).

- [ ] **Step 2: Sanity-check `WIRING.md` has no archetype-specific hardcoding**

```bash
grep -niE 'engineer|render-check|chromium|playwright' tools/cron-roles/WIRING.md
```

Expected: matches appear ONLY inside Step 8's example block and Step 4/illustrative references — never as a hardcoded assumption that the role being installed is the engineer. Fix any that are not clearly examples.

- [ ] **Step 3: Commit**

```bash
git add tools/cron-roles/WIRING.md
git commit -m "feat(cron-roles): WIRING.md — archetype-agnostic install engine"
```

---

### Task 4: `handoff-protocol.md` (dynamic awareness)

**Files:**
- Create: `tools/cron-roles/handoff-protocol.md`

- [ ] **Step 1: Author the protocol**

Must contain: (a) the routing table, (b) the absent-role fallback rule, (c) a concrete "Generating the awareness block" procedure that WIRING.md Step 4 and Step 10 call.

````markdown
# Handoff Protocol — how roles pass work to each other

Roles communicate ONLY through the task board: a file in `ops/tasks/backlog/`
with front-matter `assigned_role: <role>` and `type: <type>`.

## Canonical edges

| From | Hands to | When | Task `type` |
|---|---|---|---|
| content-writer  | engineer       | engineering problem noticed mid-edit | engineering |
| affiliate-editor| engineer       | broken cloak/redirect (/go/ 404)     | engineering |
| affiliate-editor| content-writer | stale product claim inside a guide   | content |
| seo-analyst     | content-writer | new/refresh content opportunity      | content / refresh |
| seo-analyst     | engineer       | technical SEO (canonical, sitemap)   | engineering |
| planner         | (all)          | dispatches; reads the whole board    | * |
| engineer        | (sink)         | everyone escalates here              | engineering |

## Absent-role fallback (MECHANICAL — never assume a role exists)

Before emitting a handoff instruction, the installer inventories the site:

```bash
ls "$TARGET/ops/roles/" | sed 's/\.md$//'
```

For each outgoing edge whose target role is NOT in that inventory, the awareness
block degrades the instruction to: **post a Slack alert via
`ops/scripts/notify-slack.sh` AND file a `type:<x>` task with
`assigned_role: human-triage`** — never a dangling reference to a non-existent role.

## Generating the awareness block (called by WIRING.md Steps 4 & 10)

1. Inventory existing roles (command above) → `PRESENT[]`.
2. For the role being installed, look up its outgoing edges in the table.
3. For each edge: if target ∈ PRESENT → emit the "file `assigned_role: <target>`"
   line; else → emit the fallback line.
4. Render the result under a `## Handing off work` section in the new role's body.
5. Bidirectional (Step 10): for each sibling already present that has an edge
   TO the new role, append/refresh a one-line "…and `<newrole>` now exists, file
   `assigned_role: <newrole>` for <type>" note under that sibling's
   `## Handing off work` section. Idempotent (skip if the exact line exists).
````

- [ ] **Step 2: Commit**

```bash
git add tools/cron-roles/handoff-protocol.md
git commit -m "feat(cron-roles): handoff-protocol.md — dynamic capability-based awareness + fallback"
```

---

### Task 5: Seed `archetypes/engineer/` from americastrikes

**Files:**
- Create: `tools/cron-roles/archetypes/engineer/role.md.tmpl`
- Create: `tools/cron-roles/archetypes/engineer/meta.yml`
- Create: `tools/cron-roles/archetypes/engineer/scripts/{engineer-render-check.mjs,engineer-check.sh,run-engineer.sh,enqueue-engineer-task.sh}` (copied from the americastrikes reference)
- Read for source: `sites/americastrikes.com/ops/roles/engineer.md`, `sites/americastrikes.com/ops/scripts/{engineer-render-check.mjs,engineer-check.sh,run-engineer.sh,enqueue-engineer-task.sh}`, and the existing global engineer skill's `templates/`

- [ ] **Step 1: Confirm americastrikes is the live reference**

```bash
ls sites/americastrikes.com/ops/roles/engineer.md sites/americastrikes.com/ops/scripts/engineer-*.* sites/americastrikes.com/ops/scripts/run-engineer.sh
```

Expected: all present. This is the declared canonical engineer.

- [ ] **Step 2: Copy the engineer scripts into the archetype, re-parameterizing site values to `{{PLACEHOLDER}}`**

For each script, copy from americastrikes and replace its hardcoded site values with the tokens defined in `meta.yml` (`{{BASE_URL}}`, `{{SITE_BRAND}}`, `{{SLACK_CHANNEL_VAR}}`, `{{SLACK_CHANNEL_DEFAULT}}`, `{{MODEL}}`, `{{COLLECTIONS_JSON}}`, `{{STATIC_PAGES_JSON}}`, `{{SITEMAP_PATH}}`). The `engineer-render-check.mjs` `PROJECT CONFIG` block is the only one with substantive per-site content. Cross-check against the proven token list in the existing global skill so no token is missed.

- [ ] **Step 3: Write `meta.yml`**

```yaml
name: engineer
source: americastrikes.com        # selected: declared reference; bash-driven, build-gated, render-true health check
schedule: "0 */4 * * *"
model: claude-sonnet-4-6          # invoked only when there is work; healthy+idle = 👍 heartbeat, 0 tokens
owns_task_types: [engineering]
produces_task_types: []           # the escalation sink
worker_deps: [chromium, nss, freetype, harfbuzz, ttf-freefont, "playwright-core@1.49.1"]
needs_rebuild_verify: true
placeholders:
  - BASE_URL
  - SITE_BRAND
  - MODEL
  - SLACK_CHANNEL_VAR
  - SLACK_CHANNEL_DEFAULT
  - COLLECTIONS_JSON
  - STATIC_PAGES_JSON
  - SITEMAP_PATH
scripts: [engineer-render-check.mjs, engineer-check.sh, run-engineer.sh, enqueue-engineer-task.sh]
gitignore:
  - "ops/logs/engineer-issues-*.txt"
  - "ops/logs/engineer-render-fail-*.png"
  - "ops/logs/engineer-render-last.json"
```

- [ ] **Step 4: Write `role.md.tmpl`** — americastrikes' `engineer.md` with site values tokenized and the `## Handing off work` section replaced by the marker `<!-- AWARENESS-BLOCK -->` (WIRING.md Step 4 fills it per site).

- [ ] **Step 5: Assert no stray real site values remain**

```bash
grep -rniE 'americastrikes|America Strikes|AMERICA_STRIKES' tools/cron-roles/archetypes/engineer/
```

Expected: no matches (all replaced by tokens). Fix any leak.

- [ ] **Step 6: Commit**

```bash
git add tools/cron-roles/archetypes/engineer/
git commit -m "feat(cron-roles): engineer archetype (selected from americastrikes reference)"
```

---

### Task 6: The thin `domains-cron-role-engineer` skill

**Files:**
- Create: `.claude/skills/domains-cron-role-engineer/SKILL.md`

- [ ] **Step 1: Write the thin skill**

```markdown
---
name: domains-cron-role-engineer
description: Install (or maintain) the autonomous Engineer cron role on any portfolio site under /home/jesse/projects/domains/sites/. The engineer runs every 4 hours, true-render health-checks the live site (Playwright in-container), sweeps git/Cloudflare/task-board, posts a 👍 Slack heartbeat when healthy+idle (zero tokens), and invokes Sonnet only to fix safe issues behind an authoritative build gate. Use when the user asks to "add/install the engineer role", "give <site> a health-check agent", "wire the engineer", or "update the engineer". Stamps from the americastrikes reference, wires cron + run-role + worker Dockerfile, makes siblings aware, and rebuilds+verifies the cron line is live (the sinderella guard).
---

# Install the Engineer cron role

Archetype library: `tools/cron-roles/archetypes/engineer/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `engineer`. Awareness: `tools/cron-roles/handoff-protocol.md`.

1. Run WIRING.md Steps 1–13 against the target site, reading this archetype's
   `meta.yml` for schedule/model/worker_deps/placeholders/gitignore.
2. Engineer is the escalation sink: it `owns` `type: engineering` and produces
   no handoffs. Do NOT add it to run-role.sh's Slack allowlist (run-engineer.sh
   self-posts — double-post guard).
3. The Step 11 rebuild+verify is MANDATORY — engineer adds chromium to
   Dockerfile.worker, so both `worker` and `cron` images must rebuild. An install
   that skips verify looks done but is dead (sinderella.org, weeks dark).

Maintain mode: if `ops/roles/engineer.md` already exists, re-run Steps 4, 10, 11
only (refresh body + awareness, re-verify) — never destroy operator edits.
```

- [ ] **Step 2: Verify the validator still fails pre-install on a fresh target**

Choose the fresh-install target: `xxxtea.com` (has the ops pattern, no engineer).

```bash
ls sites/xxxtea.com/ops/roles/engineer.md 2>&1   # expect: No such file
bash tools/cron-roles/validate-install.sh sites/xxxtea.com engineer; echo "exit=$?"
```

Expected: `FAIL: role file missing …` and `exit=1`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/domains-cron-role-engineer/
git commit -m "feat(skill): domains-cron-role-engineer (thin pointer over WIRING.md)"
```

---

### Task 7: End-to-end install + the sinderella-guard proof

**Files:** none created; this exercises the engine against a real site.

- [ ] **Step 1: Run the engineer install on the fresh target via the skill procedure**

Target: `xxxtea.com`. Execute `tools/cron-roles/WIRING.md` Steps 1–13 for `engineer`. This rebuilds `worker` + `cron`, stamps the role, wires cron, makes siblings (planner, seo-analyst, content-writer, affiliate-ops, deployer, smoke-tester) aware.

- [ ] **Step 2: Run the validator — it must now PASS including the live-container check**

```bash
bash tools/cron-roles/validate-install.sh sites/xxxtea.com engineer; echo "exit=$?"
```

Expected: `PASS: engineer installed in sites/xxxtea.com` and `exit=0`, with NO `WARN` (the cron container is up, so the live check runs).

- [ ] **Step 3: Prove the guard catches a stale image (negative test)**

Add a throwaway second cron comment, do NOT rebuild, and confirm the validator still passes for the already-baked `engineer` line (the line is live) — then confirm that if you grep for the un-baked marker it is absent in-container. This demonstrates the live-container check is reading the running crontab, not the file.

```bash
cd sites/xxxtea.com
CRON_CTR="$(docker compose ps -q cron)"
docker exec "$CRON_CTR" crontab -l | grep -c engineer   # expect: >=1
cd /home/jesse/projects/domains
```

- [ ] **Step 4: Dry run + heartbeat**

```bash
cd sites/xxxtea.com && bash ops/scripts/run-worker.sh engineer; cd /home/jesse/projects/domains
ls -t sites/xxxtea.com/ops/logs/engineer-*.log | head -1
```

Expected: a fresh log, a 👍 (or work) Slack message in xxxtea's channel, a `last-run.json` engineer entry.

- [ ] **Step 5: Commit the xxxtea install**

```bash
cd sites/xxxtea.com
git add ops/roles ops/scripts ops/docker .gitignore ops/board
git commit -m "engineer: install autonomous cron role via domains-cron-role-engineer (rebuild required to activate)"
cd /home/jesse/projects/domains
```

---

### Task 8: Retire the two superseded engineer skills

**Files:**
- Remove: `.claude/skills/domains-agent-cron-role-engineer/`
- Remove: `/home/jesse/.claude/skills/skill-domain-add-engineer-role/`

- [ ] **Step 1: Confirm the new skill fully covers both old ones**

```bash
grep -L 'WIRING.md' .claude/skills/domains-cron-role-engineer/SKILL.md   # expect: empty (it references WIRING)
```

Confirm Task 7 passed (new skill installs cleanly end-to-end) before deleting anything.

- [ ] **Step 2: Remove the superseded skills**

```bash
git rm -r .claude/skills/domains-agent-cron-role-engineer/
rm -rf /home/jesse/.claude/skills/skill-domain-add-engineer-role/
```

- [ ] **Step 3: Commit**

```bash
git add -A .claude/skills/
git commit -m "chore(skills): retire engineer-only skills, superseded by domains-cron-role-engineer + cron-roles library"
```

---

## Phase 1 — affiliate-editor

### Task 9: Select the best affiliate implementation

**Files:** none yet — this is the comparison that produces the archetype source.

- [ ] **Step 1: Dump the candidate role bodies side by side**

```bash
for f in sites/reviewtattoo.com/ops/roles/affiliate-tester.md \
         sites/ultrarough.com/ops/roles/affiliate.md \
         sites/wetpages.com/ops/roles/affiliate.md \
         sites/aliencouncil.com/ops/roles/affiliate-ops.md \
         sites/xxxtea.com/ops/roles/affiliate-ops.md; do
  echo "===== $f ====="; cat "$f"; echo; done
```

- [ ] **Step 2: Score each against the selection bar and record the winner**

Selection bar (from spec): bash-driven where possible, build-gated (or correctly no-deploy), task-board integrated (owns + produces typed tasks), Slack heartbeat, explicit anti-slop rules, self-locking + cron-safe. Write a 5-line verdict per candidate into the archetype `meta.yml` header comment naming the chosen `source:` and why (e.g. reviewtattoo's `affiliate-tester` — curl-checks every `/go/` link, files typed tasks, no-deploy by design).

- [ ] **Step 3: Commit the decision note** (a stub `meta.yml` with the verdict; body filled next task)

```bash
git add tools/cron-roles/archetypes/affiliate-editor/meta.yml
git commit -m "docs(cron-roles): affiliate-editor source selection verdict"
```

---

### Task 10: Build the affiliate-editor archetype + skill

**Files:**
- Create/finalize: `tools/cron-roles/archetypes/affiliate-editor/{role.md.tmpl,meta.yml}`
- Create: `.claude/skills/domains-cron-role-affiliate-editor/SKILL.md`

- [ ] **Step 1: Write `meta.yml`** — based on the Task 9 winner:

```yaml
name: affiliate-editor
source: reviewtattoo.com/affiliate-tester   # or Task-9 winner
schedule: "0 7 * * 3"            # winner's cadence
model: claude-sonnet-4-6
owns_task_types: [affiliate]
produces_task_types: [engineering, content]   # broken /go/ -> engineer; stale claim -> content-writer
worker_deps: []
needs_rebuild_verify: true       # crontab.docker is baked into the cron image
placeholders: [BASE_URL, SITE_BRAND, MODEL, SLACK_CHANNEL_VAR, SLACK_CHANNEL_DEFAULT, AFFILIATE_REGISTRY_PATH, GO_PREFIX]
scripts: []
gitignore: []
```

- [ ] **Step 2: Write `role.md.tmpl`** — the winner's body, site values tokenized, `## Handing off work` replaced by `<!-- AWARENESS-BLOCK -->`. Keep its anti-slop and "verify against the registry" rules verbatim.

- [ ] **Step 3: Write the thin skill `.claude/skills/domains-cron-role-affiliate-editor/SKILL.md`** — same shape as engineer's: name + description (triggers: "add the affiliate editor", "install affiliate link checker", "<site> affiliate role"), and "follow `tools/cron-roles/WIRING.md` with `<name>=affiliate-editor`." Note it produces handoffs (so the awareness block has outgoing edges) and is NOT the escalation sink.

- [ ] **Step 4: Assert no source-site values leak**

```bash
grep -rniE 'reviewtattoo|review tattoo|REVIEWTATTOO' tools/cron-roles/archetypes/affiliate-editor/
```

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add tools/cron-roles/archetypes/affiliate-editor/ .claude/skills/domains-cron-role-affiliate-editor/
git commit -m "feat(cron-roles): affiliate-editor archetype + skill"
```

---

### Task 11: Install + validate affiliate-editor on a test site

**Files:** none created — exercises the engine.

- [ ] **Step 1: Pick a target that monetizes via affiliate but lacks the role**, e.g. `ultrarough.com` already has `affiliate` — instead pick a site with `/go/` cloaking but no affiliate role, or run in maintain mode to replace an ad-hoc one. Record the chosen target.

- [ ] **Step 2: Run WIRING.md Steps 1–13 for `affiliate-editor`** against the target.

- [ ] **Step 3: Validate**

```bash
bash tools/cron-roles/validate-install.sh sites/<target> affiliate-editor; echo "exit=$?"
```

Expected: `PASS` + `exit=0`, live-container check included.

- [ ] **Step 4: Confirm dynamic awareness resolved correctly**

```bash
grep -A3 'Handing off work' sites/<target>/ops/roles/affiliate-editor.md
```

Expected: if the target HAS an engineer → a line filing `assigned_role: engineer` for broken `/go/` links; if NOT → the Slack + `human-triage` fallback line. Verify it matches the target's actual `ls ops/roles/`.

- [ ] **Step 5: Commit the install** (in the site repo, as in Task 7 Step 5).

---

## Phase 2 — content-writer

### Task 12: Select + build content-writer

**Files:**
- Create: `tools/cron-roles/archetypes/content-writer/{role.md.tmpl,meta.yml}`
- Create: `.claude/skills/domains-cron-role-content-writer/SKILL.md`

- [ ] **Step 1: Compare candidates**

```bash
for f in sites/reviewtattoo.com/ops/roles/content-writer.md \
         sites/americastrikes.com/ops/roles/news-writer.md \
         sites/weapontester.com/ops/roles/content-writer.md \
         sites/aliencouncil.com/ops/roles/content-writer.md \
         sites/xxxtea.com/ops/roles/content-writer.md; do
  echo "===== $f ====="; cat "$f"; echo; done
```

- [ ] **Step 2: Score against the selection bar; pick the winner.** Content-writer has the highest per-site voice variance, so the template MUST quarantine voice into a clearly-marked `## Writing voice (TUNE PER SITE)` block — everything above it generic (task pickup, refresh checklist, affiliate rules, handoff), the voice block a short stamped-then-tuned stub seeded from the winner.

- [ ] **Step 3: Write `meta.yml`**

```yaml
name: content-writer
source: reviewtattoo.com         # or Task-12 winner
schedule: "0 7 * * 6"
model: claude-sonnet-4-6
owns_task_types: [content, refresh]
produces_task_types: [engineering]   # notices a build/redirect bug mid-edit -> engineer (or fallback)
worker_deps: []
needs_rebuild_verify: true
placeholders: [SITE_NAME, BASE_URL, MODEL, SLACK_CHANNEL_VAR, SLACK_CHANNEL_DEFAULT, CONTENT_COLLECTIONS, AFFILIATE_REGISTRY_PATH, GO_PREFIX]
scripts: []
gitignore: []
```

- [ ] **Step 4: Write `role.md.tmpl`** (generic body + `<!-- AWARENESS-BLOCK -->` + the `## Writing voice (TUNE PER SITE)` stub) and the thin skill (triggers: "add the content writer", "install the writer role", "<site> content writer").

- [ ] **Step 5: Leak check + commit**

```bash
grep -rniE 'reviewtattoo|tattoo' tools/cron-roles/archetypes/content-writer/   # expect none outside generic examples
git add tools/cron-roles/archetypes/content-writer/ .claude/skills/domains-cron-role-content-writer/
git commit -m "feat(cron-roles): content-writer archetype + skill (voice quarantined for per-site tuning)"
```

---

### Task 13: Install + validate content-writer (stamp-once-tune-locally proof)

- [ ] **Step 1: Pick a target lacking a content-writer** (record it), run WIRING.md Steps 1–13 for `content-writer`.

- [ ] **Step 2: Validate**

```bash
bash tools/cron-roles/validate-install.sh sites/<target> content-writer; echo "exit=$?"
```

Expected: `PASS` + `exit=0`.

- [ ] **Step 3: Confirm the voice block is a stub, not the source site's voice**

```bash
sed -n '/Writing voice (TUNE PER SITE)/,/^## /p' sites/<target>/ops/roles/content-writer.md
```

Expected: a short generic stub instructing the operator to define voice — NOT reviewtattoo's "skeptical tattoo insider" voice. This proves stamp-once-tune-locally.

- [ ] **Step 4: Commit the install.**

---

## Phase 3 — planner + seo-analyst

### Task 14: Select + build planner

**Files:**
- Create: `tools/cron-roles/archetypes/planner/{role.md.tmpl,meta.yml}`
- Create: `.claude/skills/domains-cron-role-planner/SKILL.md`

- [ ] **Step 1: Compare candidates**

```bash
for f in sites/aliencouncil.com/ops/roles/planner.md sites/americastrikes.com/ops/roles/planner.md \
         sites/sinderella.org/ops/roles/planner.md sites/weapontester.com/ops/roles/planner.md \
         sites/ultrarough.com/ops/roles/planner.md sites/wetpages.com/ops/roles/planner.md \
         sites/xxxtea.com/ops/roles/planner.md; do echo "===== $f ====="; cat "$f"; echo; done
```

- [ ] **Step 2: Score; pick winner.** Planner is the dispatcher: its awareness block enumerates ALL present roles (it reads the whole board). Its `produces_task_types` is effectively `*`; encode that the awareness generator lists every present sibling and the typed tasks each owns.

- [ ] **Step 3: Write `meta.yml`** (schedule from winner; `model: claude-sonnet-4-6`; `owns_task_types: [ops, planning]`; `produces_task_types: ["*"]`; `worker_deps: []`; `needs_rebuild_verify: true`; placeholders: SITE_NAME, BASE_URL, MODEL, SLACK_CHANNEL_VAR, SLACK_CHANNEL_DEFAULT).

- [ ] **Step 4: Write `role.md.tmpl` + thin skill**; leak-check; commit.

```bash
git add tools/cron-roles/archetypes/planner/ .claude/skills/domains-cron-role-planner/
git commit -m "feat(cron-roles): planner archetype + skill"
```

---

### Task 15: Select + build seo-analyst

**Files:**
- Create: `tools/cron-roles/archetypes/seo-analyst/{role.md.tmpl,meta.yml}`
- Create: `.claude/skills/domains-cron-role-seo-analyst/SKILL.md`

- [ ] **Step 1: Compare candidates**

```bash
for f in sites/aliencouncil.com/ops/roles/seo-analyst.md sites/americastrikes.com/ops/roles/seo-analyst.md \
         sites/sinderella.org/ops/roles/seo-analyst.md sites/weapontester.com/ops/roles/seo-analyst.md \
         sites/ultrarough.com/ops/roles/seo-analyst.md sites/wetpages.com/ops/roles/seo-analyst.md \
         sites/xxxtea.com/ops/roles/seo-analyst.md; do echo "===== $f ====="; cat "$f"; echo; done
```

- [ ] **Step 2: Score; pick winner.** seo-analyst's edges: → content-writer (`content`/`refresh`), → engineer (technical SEO). Both subject to the absent-role fallback.

- [ ] **Step 3: Write `meta.yml`** (`owns_task_types: [seo]`; `produces_task_types: [content, refresh, engineering]`; schedule from winner; placeholders incl. SITE_URL for GSC/data references; `worker_deps: []`; `needs_rebuild_verify: true`).

- [ ] **Step 4: Write `role.md.tmpl` + thin skill**; leak-check; commit.

```bash
git add tools/cron-roles/archetypes/seo-analyst/ .claude/skills/domains-cron-role-seo-analyst/
git commit -m "feat(cron-roles): seo-analyst archetype + skill"
```

---

### Task 16: Install + validate planner and seo-analyst together (cross-awareness proof)

- [ ] **Step 1: Pick a target lacking both** (or run maintain), install planner then seo-analyst via WIRING.md.

- [ ] **Step 2: Validate both**

```bash
bash tools/cron-roles/validate-install.sh sites/<target> planner;     echo "exit=$?"
bash tools/cron-roles/validate-install.sh sites/<target> seo-analyst; echo "exit=$?"
```

Expected: both `PASS` + `exit=0`.

- [ ] **Step 3: Prove bidirectional awareness** — installing seo-analyst second must have updated planner's awareness block to mention seo-analyst, AND seo-analyst's block must route to content-writer/engineer per what's present.

```bash
grep -A6 'Handing off work' sites/<target>/ops/roles/planner.md
grep -A6 'Handing off work' sites/<target>/ops/roles/seo-analyst.md
```

Expected: planner lists seo-analyst among present roles; seo-analyst routes correctly (real role or fallback) per the target's inventory.

- [ ] **Step 4: Commit the installs.**

---

## Phase 4 — Close-out

### Task 17: Family README + memory + finish

- [ ] **Step 1: Update `tools/cron-roles/README.md`** with the final archetype list and a one-line "to add a new archetype: create `archetypes/<name>/` + a thin `domains-cron-role-<name>` skill" recipe.

- [ ] **Step 2: Write a memory pointer** at `/home/jesse/.claude/projects/-home-jesse-projects-domains/memory/reference_cron_role_family.md` (type: reference) describing the library + the five skills + the stamp-once/handoff/selection model, and add a line to `MEMORY.md`. Link `[[reference_cron_manager.md]]` and `[[project_cron_audit_2026-06.md]]`.

- [ ] **Step 3: Final commit + branch wrap**

```bash
git add tools/cron-roles/README.md
git commit -m "docs(cron-roles): finalize family README + add-archetype recipe"
```

Then use superpowers:finishing-a-development-branch to decide merge/PR for `feat/cron-role-family`.

---

## Self-Review Notes

- **Spec coverage:** structure (Tasks 1,3,5,6,10,12,14,15) ✓; stamp-once non-sync (README Task 1, content-writer voice stub Task 13) ✓; one-skill-per-archetype + single wiring engine (Tasks 3,6 + thin skills) ✓; dynamic capability-based handoff + absent-role fallback (Task 4, validated Tasks 11/16) ✓; best-implementation selection with recorded rationale (Tasks 5,9,12,14,15) ✓; sinderella rebuild-verify guard (validator Task 2, proven Task 7) ✓; retire old engineer skills (Task 8) ✓; non-goal of not normalizing live sites — respected (no task touches an existing role except additive awareness lines) ✓.
- **Placeholders:** archetype bodies are deliberately "copy the selected winner + tokenize named values" — the concrete inputs (which files, which tokens) are specified, so these are actions not TBDs.
- **Type consistency:** `<!-- AWARENESS-BLOCK -->` marker, `validate-install.sh <site> <role>` signature, and `meta.yml` field names (`owns_task_types`, `produces_task_types`, `worker_deps`, `needs_rebuild_verify`) are used identically across all tasks.
