# Cron-Role Skill Family — Design

**Date:** 2026-06-15
**Status:** Approved (design); implementation plan pending
**Author:** Claude (operator), with Jesse (board)

## Problem

The portfolio runs a handful of recurring autonomous cron roles — `engineer`,
`deployer`, `planner`, `seo-analyst`, `content-writer`, and various
`affiliate*` / `social*` roles. Each is re-implemented per site, and the only
"reuse" mechanism today is **two overlapping engineer-only skills**
(`skill-domain-add-engineer-role` global + `domains-agent-cron-role-engineer`
project-local) that already drift from each other and only know how to install
the engineer.

The mechanical wiring (cron line, `run-role.sh` dispatch branch, worker-container
deps, lockfile/log/Slack-heartbeat, task-board hooks, sibling-awareness, the
rebuild-and-verify guard) is ~90% identical no matter which role is being
installed. What genuinely differs is (1) the **role body** — rules, voice,
schedule, collections — and (2) a handful of **site values** — brand marker, base
URL, Slack channel, content collections.

## Goals

- Make installing any of the standard roles into any portfolio site a single,
  repeatable skill invocation.
- Keep roles **un-aligned**: each site's role body is tuned locally and is never
  overwritten after install.
- Eliminate the wiring duplication/drift between the two engineer skills.
- Each installed role becomes **dynamically aware** of which sibling roles
  actually exist on that site, and degrades gracefully when a target role is
  absent.
- Standardize on the **best existing implementation** of each archetype, selected
  by comparison rather than authored from scratch.

## Non-Goals

- **Normalizing live sites.** We do not retrofit, re-sync, or align the roles on
  existing sites. (Aspirational; explicitly out of scope for now.)
- **Ongoing sync of installed roles.** This is **stamp-once**: the installer
  scaffolds a complete, working role + wiring, then walks away. All future edits
  to an installed role are per-site and manual. Mechanical improvements to an
  archetype do **not** propagate back to already-installed sites.
- A central runtime/scheduler change. The existing Docker `cron` + one-shot
  `worker` container pattern is unchanged; this is about *authoring and
  installing* roles, not running them.

## Decisions (from brainstorming)

1. **Update model: stamp-once, then fully local.** No linked skeleton, no
   override-merge layer. Simplest, and matches "no full alignment."
2. **Packaging: one skill per archetype** — a clean family of `/`-commands — but
   the mechanical wiring is factored into **one shared reference** that every
   skill points to, so there is exactly one copy of the wiring engine.
3. **First cut: all four archetypes** — engineer (consolidate existing),
   affiliate-editor, content-writer, planner + seo-analyst.
4. **Skill naming: `domains-` prefix**, matching the existing domain skills:
   `domains-cron-role-engineer`, `domains-cron-role-affiliate-editor`,
   `domains-cron-role-content-writer`, `domains-cron-role-planner`,
   `domains-cron-role-seo-analyst`.

## Architecture

### Library layout (single source of truth, version-controlled)

```
tools/cron-roles/
  WIRING.md                 # the mechanical 90%, written ONCE
  handoff-protocol.md       # canonical task-board handoff edges + fallback rules
  archetypes/
    engineer/         role.md.tmpl  meta.yml  scripts/engineer-render-check.mjs …
    affiliate-editor/ role.md.tmpl  meta.yml
    content-writer/   role.md.tmpl  meta.yml
    planner/          role.md.tmpl  meta.yml
    seo-analyst/      role.md.tmpl  meta.yml
```

The library lives at `tools/cron-roles/` (not buried inside a skill) so it is
inspectable, version-controlled with the portfolio, and a future cron-manager UI
could surface it.

### Skill layout (thin, one per archetype)

```
.claude/skills/
  domains-cron-role-engineer/SKILL.md
  domains-cron-role-affiliate-editor/SKILL.md
  domains-cron-role-content-writer/SKILL.md
  domains-cron-role-planner/SKILL.md
  domains-cron-role-seo-analyst/SKILL.md
```

Each `SKILL.md` is thin: it names the archetype, points at
`tools/cron-roles/WIRING.md` for the mechanical steps, and points at its own
`tools/cron-roles/archetypes/<name>/` for the role body, `meta.yml`, and any
archetype-specific scripts. These skills only ever run inside the domains repo,
so referencing an in-repo library is safe.

### `meta.yml` (per-archetype knobs)

Carries everything the shared wiring needs to parameterize an install:

- `schedule` — cron expression (e.g. `0 */4 * * *`)
- `model` — e.g. `claude-sonnet-4-6`, or `none` for bash-only roles
- `owns_task_types` — task `type:` values this role picks up from the backlog
- `produces_task_types` — task types it files for other roles
- `worker_deps` — extra `Dockerfile.worker` deps (e.g. engineer needs
  `chromium` + `playwright-core` for true-render; most roles need none)
- `placeholders` — the site values the wiring must resolve and substitute
- `needs_rebuild_verify` — always true (the sinderella guard)

### `WIRING.md` (the mechanical engine, written once)

Extracted from the current engineer skill. Steps, archetype-agnostic:

1. **Confirm target & preconditions** — `ops/scripts/{run-role,run-worker,notify-slack}.sh`,
   `ops/docker/{crontab.docker,Dockerfile.worker}`, `docker-compose.yml`,
   `ops/tasks/{backlog,in-progress,done}/`, a Slack channel var in
   `/home/jesse/projects/domains/.env`.
2. **Detect project context** — site name, base URL, Slack channel + env var,
   content collections, brand marker string. Resolve the archetype's
   `placeholders`.
3. **Stamp the role file** — copy `archetypes/<name>/role.md.tmpl` →
   `ops/roles/<name>.md`, substitute placeholders, generate the dynamic
   awareness section (see Handoff Protocol).
4. **Stamp archetype scripts** (if any) and `chmod +x`.
5. **Wire `run-role.sh`** — add a dispatch branch for the role (model from
   `meta.yml`).
6. **Wire `crontab.docker`** — add the schedule line (idempotent; skip if present).
7. **Wire `Dockerfile.worker`** — add `worker_deps` only if non-empty.
8. **Update `.gitignore`** — ignore the role's per-run scratch (e.g. engineer's
   render logs/screenshots) so `git add -A` fixes don't commit junk.
9. **Sibling awareness** — update existing sibling roles to know the newcomer
   exists (bidirectional; see Handoff Protocol).
10. **Rebuild + VERIFY (the sinderella guard)** — `docker compose build worker
    cron`, `up -d cron`, then assert the new cron line is live *in the running
    container*. If grep finds nothing, the image is stale — do not declare done.
11. **Dry run** — `bash ops/scripts/run-worker.sh <name>`; confirm Slack
    heartbeat + log + `last-run.json` entry; seed a throwaway task and confirm
    pickup + build-gate.
12. **Commit** — scripts, role files, Dockerfile, crontab, board log together;
    note that activation required the image rebuild.

### Handoff Protocol (dynamic cross-role awareness)

Roles communicate **only through the task board**: drop a file in
`ops/tasks/backlog/` with frontmatter `assigned_role: <role>` and `type: <type>`.

At install time the wiring **inventories `ops/roles/`** to learn which roles
exist on *this* site, then generates the new role's handoff section
**conditionally**:

> "Found an engineering problem (broken render, build break, redirect bug)?
> **If** an `engineer` role exists → file a task `assigned_role: engineer,
> type: engineering`. **Else** → escalate to Slack and file a `type: engineering`
> human-triage task."

`handoff-protocol.md` defines the canonical edges:

| From | Hands off to | When |
|---|---|---|
| content-writer | engineer | engineering problem noticed mid-edit |
| affiliate-editor | engineer | broken cloak/redirect |
| affiliate-editor | content-writer | stale product claim inside a guide |
| seo-analyst | content-writer | files `content`/`refresh` tasks |
| seo-analyst | engineer | technical SEO (broken canonical, sitemap) |
| planner | all | dispatcher; reads the whole board |
| engineer | — | the escalation sink (everyone files to it) |

**Fallback rule (mechanically enforced):** no site is assumed to have any given
role. When a target role is absent, the handoff degrades to **Slack alert + a
`type:<x>` human-triage task**. This satisfies "not all sites have an engineer."

### "Best implementation wins" — selection, not authoring

Before writing each `role.md.tmpl`, compare the live copies across sites and
pick/merge the best. Selection bar (recorded here as the standard):

- bash-driven where possible (near-zero Claude turns for mechanical work)
- build-gated (authoritative `npm run build` before any push)
- task-board integrated (owns + produces typed tasks)
- Slack heartbeat each run (compact 👍 when healthy + idle)
- explicit anti-slop voice rules in the body
- self-locking (flock), timestamped logs, cron-safe PATH/HOME

Per-archetype source candidates:

- **engineer** → `americastrikes.com` (already the declared reference).
- **planner / seo-analyst** → compare aliencouncil, americastrikes, sinderella,
  weapontester, ultrarough, wetpages, xxxtea.
- **content-writer** → compare reviewtattoo, americastrikes, weapontester,
  aliencouncil, xxxtea.
- **affiliate-editor** → compare reviewtattoo's `affiliate-tester`,
  ultrarough/wetpages `affiliate`, aliencouncil/xxxtea `affiliate-ops`.

The comparison is run as a parallel sweep during implementation; the chosen
source (and why) is recorded in each archetype's `meta.yml` header.

## Build order

1. **Foundation** — extract `WIRING.md` + `handoff-protocol.md` from the engineer
   skill; consolidate the two existing engineer skills into
   `domains-cron-role-engineer`; seed `archetypes/engineer/`. Proves the pattern
   with zero new-role risk. Retire `skill-domain-add-engineer-role` and the old
   `domains-agent-cron-role-engineer` once the consolidated skill installs
   cleanly on a test site.
2. **affiliate-editor** — highest reuse; first real test of the engine on a fresh
   archetype.
3. **content-writer** — biggest per-site voice variance; tests
   stamp-once-tune-locally.
4. **planner + seo-analyst** — the remaining recurring archetypes.

## Validation (per install, inherited from the engineer skill)

- Rebuild → assert the cron line is live in the running container (sinderella
  guard).
- Dry run → Slack heartbeat lands, log + `last-run.json` written.
- Seed a throwaway typed task → confirm pickup + build-gate.

## Risks & mitigations

- **Stale-image silent failure** (the sinderella bug). Mitigated by the mandatory
  rebuild-and-verify step in `WIRING.md`; an install that skips it is not "done."
- **Drift returning** if an archetype skill copy-pastes wiring instead of
  referencing `WIRING.md`. Mitigated by keeping skills thin and the engine
  single-sourced; a skill that inlines wiring is a review failure.
- **Handoff to a role that exists but is paused/broken.** The task simply waits in
  the backlog; the planner (where present) or the human triage path surfaces
  starvation. Acceptable for stamp-once.
- **Best-implementation selection is subjective.** Mitigated by the explicit
  selection bar above and recording the chosen source + rationale in `meta.yml`.
