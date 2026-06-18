---
name: domains-cron-role-maintainer
description: >-
  Manage the portfolio's autonomous cron-role family — the tools/cron-roles/ library and the
  six domains-cron-role-* installer skills (engineer, affiliate-editor, content-writer, planner,
  seo-analyst, watchdog) that stamp autonomous roles onto sites under /home/jesse/projects/domains/sites/.
  Use this skill WHENEVER the work is about the cron-role system itself rather than just firing one
  install: adding a NEW role archetype, editing/updating an existing archetype or its skill,
  pushing an archetype change out to already-installed sites (stamp-once means edits do NOT
  auto-propagate), troubleshooting a failed or "looks-installed-but-dead" install, understanding
  the engine (WIRING.md / handoff-protocol.md / the validator), or wiring the family up with the
  cron-manager panel. Triggers include: "add a cron role for X", "edit/update the engineer (or
  affiliate/planner/seo/content) role", "change the engineer heartbeat", "push that role change to
  the other sites", "a role install didn't take / the cron line isn't live", "how do the
  domains-cron-role skills work", "maintain the cron roles", "the engineer is misbehaving on
  <site>", or any change to tools/cron-roles/. If the task only toggles/pauses an EXISTING job from
  the panel, prefer cron-manager-maintenance; if it touches the role library or archetypes, use this.
---

# Cron-Role Maintainer

The portfolio runs autonomous roles on cron (engineer, content-writer, etc.). This skill is the
operator's guide for the **system that installs and maintains them** — not for running one install
(the per-archetype skills do that), but for working *on the family*: authoring, editing, updating,
deploying, and debugging.

## Mental model (internalize this first)

Two layers, deliberately separated:

1. **One shared engine** at `tools/cron-roles/` — the mechanical 90% that is identical for every
   role. Skills never re-implement it; they point at it.
   - `WIRING.md` — the single archetype-agnostic install procedure (13 steps + maintain mode). **This
     is the source of truth for how an install works. Read it before any install or wiring change.**
   - `handoff-protocol.md` — how roles pass work through the task board, and how each role's
     awareness block is generated *dynamically per site*.
   - `validate-install.sh <site> <role>` — the pass/fail gate, including the live-container check.
   - `README.md` — the stamp-once model + the add-a-new-archetype recipe.
   - `archetypes/<name>/` — `role.md.tmpl` (the role body, with `{{UPPERCASE}}` tokens + a
     `<!-- AWARENESS-BLOCK -->` marker), `meta.yml` (the knobs), and optional `scripts/`.
2. **Six thin skills** at `.claude/skills/domains-cron-role-<name>/` — one per archetype. Each is a
   short pointer: "install `<name>`; follow `WIRING.md`." All site-specifics come from `meta.yml`
   and the per-site detection in WIRING Step 2. (The `watchdog` skill is the exception — it is
   cron-direct and carries its own install steps, since generic WIRING does not apply; see below.)

**Stamp-once is the load-bearing design decision.** The installer scaffolds a complete, working role
and walks away. An installed role's body is then tuned per site and is *never re-synced*. So
improving an archetype here does **not** reach already-installed sites — propagating a fix is a
deliberate, explicit act (see *Update a live site* below). This is intentional: sites stay un-aligned
(e.g. content-writer voice differs everywhere), which is what Jesse wants.

## The six archetypes

| Archetype | Kind | Owns → Produces | Schedule | Selected from |
|---|---|---|---|---|
| `engineer` | bash-driven, escalation **sink** | engineering → — | `0 */4 * * *` | americastrikes |
| `affiliate-editor` | LLM, **no-deploy** sentinel | affiliate → content, engineering | `0 7 * * 3` | reviewtattoo |
| `content-writer` | LLM, deploy; voice = per-site stub | content, refresh → engineering | `0 7 * * 6` | reviewtattoo |
| `planner` | LLM, **dispatcher** | ops, planning → * | `0 6 * * 1` | wetpages |
| `seo-analyst` | LLM, **diagnose-only** | seo → content, refresh, engineering | `0 6 * * 3` | wetpages |
| `watchdog` | bash-driven, **cron-direct** self-healer | — → engineering (escalation) | `2,17,32,47 * * * *` | americastrikes |

`engineer` is special: `model: none` (bash-driven, its `run-engineer.sh` picks the model itself) and
`self_notifies: true` (it posts its own Slack — never add it to `run-role.sh`'s notify allowlist).
`watchdog` is the other exception and goes further: `model: none`, `self_notifies: true`, AND
**`kind: cron-direct`** — its crontab line runs `run-watchdog.sh` straight in the cron container (like
`run-deployer.sh`), so it has **no** `run-role.sh` branch, no task pickup, and `validate-install.sh`
does not apply. It also depends on an **incident contract**: other roles' failure branches call
`ops/scripts/emit-incident.sh`, and the watchdog consumes `ops/health/incidents/`. Its own
`domains-cron-role-watchdog` skill carries the cron-direct install + validation steps. All the
remaining roles are normal LLM roles dispatched with `--model` from meta.

## Playbooks

### Install / deploy a role onto a site
Invoke the per-archetype skill (`domains-cron-role-<name>`) against the target, or run WIRING.md
yourself. Either way the spine is WIRING.md Steps 1–13. Don't paraphrase it — **open it**. The parts
that bite:
- **Step 2 detection is naive** — it greps the first `https://` in CLAUDE.md (often an Amazon link),
  and `site/src/content/` may be empty on data-driven sites. Verify the resolved BASE_URL / brand /
  collections by hand. The engineer's content-model tokens (`COLLECTIONS_JSON`, `STATIC_PAGES_JSON`,
  `SITE_BRAND`, `SITEMAP_PATH`) are **not** auto-detected — use `meta.placeholder_detection`.
- **Step 11 is non-negotiable**: `crontab.docker` is baked into the cron image at build time, so a
  new line is invisible until you `docker compose build cron && up -d cron`. Then
  `validate-install.sh` must print `PASS` with **no** `WARN` (the live-container check must run). An
  install that skips this *looks done but is dead* — this is the sinderella bug (a role scheduled for
  weeks that never fired). Never declare done on a `WARN`.
- **Dynamic awareness**: the role's `<!-- AWARENESS-BLOCK -->` is filled from `handoff-protocol.md`
  using the site's *actual* `ls ops/roles/`. If a handoff target (e.g. `engineer`) doesn't exist on
  that site, it degrades to a Slack alert + `assigned_role: human-triage` task — never a dangling ref.

### Add a NEW archetype to the family
The recipe lives in `tools/cron-roles/README.md`; the short version:
1. `tools/cron-roles/archetypes/<name>/role.md.tmpl` — the best existing implementation of that role,
   selected by comparing live copies across sites against the bar (mechanical clarity, task-board
   integration, deploy discipline, source-of-truth rigor, anti-slop guardrails, reusability). Tokenize
   site-specifics as `{{UPPERCASE}}`; put a `## Handing off work` heading + one `<!-- AWARENESS-BLOCK -->`
   marker (never hardcode destination roles). Record `source:` + rationale in the `meta.yml` header.
2. `meta.yml` — copy the field set from an existing one (`schedule`, `model`, `owns_task_types`,
   `produces_task_types`, `worker_deps`, `needs_rebuild_verify`, `self_notifies`, `deploy`, `scripts`,
   `gitignore`, `placeholders`, `placeholder_detection`).
3. A thin `.claude/skills/domains-cron-role-<name>/SKILL.md` (copy an existing skill's shape; `domains-`
   prefix is required). Don't inline WIRING steps.
4. **Dry-stamp validate** (no production install needed): substitute sample placeholder values into a
   throwaway copy, confirm zero `{{}}` remain, the awareness marker is present once, and `meta.yml`
   parses. Pattern:
   ```bash
   T=$(mktemp -d); cp tools/cron-roles/archetypes/<name>/role.md.tmpl "$T/r.md"
   sed -i -e 's/{{SITE_NAME}}/Sample/g' -e 's#{{BASE_URL}}#https://example.com#g' ... "$T/r.md"
   grep -c '{{' "$T/r.md"; grep -c 'AWARENESS-BLOCK' "$T/r.md"
   python3 -c "import yaml; yaml.safe_load(open('tools/cron-roles/archetypes/<name>/meta.yml'))"
   ```
   The engine is already proven by live installs, so dry-stamp is enough; do a real install on-demand
   when a site actually wants the role.

### Edit / update an existing archetype
Edit `archetypes/<name>/role.md.tmpl`, its `scripts/*.tmpl`, or `meta.yml`. Commit on a branch, leak-check
(no real site/brand strings in templates), dry-stamp validate. **Remember stamp-once**: this changes
future installs only.

### Push an archetype change out to already-installed sites (the update flow)
Because of stamp-once, a fixed archetype does not reach live sites by itself. To update a site that
already runs the role, **re-stamp its live scripts from the fixed template** and rebuild:
```bash
# re-stamp the changed script(s) with that site's placeholder values
sed -e 's#{{BASE_URL}}#https://<domain>#g' -e 's#{{SITE_SHORT}}#<short>#g' ... \
    tools/cron-roles/archetypes/<name>/scripts/<script>.tmpl > sites/<domain>/ops/scripts/<script>
# role.md / crontab live in the site repo; scripts are bind-mounted into the worker, so script-only
# changes take effect on the NEXT run with no rebuild. crontab/Dockerfile changes DO need a rebuild.
```
Then commit + push in the *site's* submodule repo, and (if you changed crontab/Dockerfile or want a
clean container) rebuild. Verify with `validate-install.sh` and one dry run. This is exactly how the
engineer heartbeat fix was rolled to xxxtea.

### Troubleshoot "looks installed but isn't firing"
Almost always the sinderella bug: the cron image is stale. `validate-install.sh <site> <role>` reads
the *running* container's crontab; if it fails the live-container check, `docker compose build cron &&
up -d cron` and re-verify. If the dispatcher is generic (`claude -p "$(cat role.md)"` for any role)
and a *bash-driven* role isn't running its sweep, it's the Rule-0 gap — see Gotchas.

## Gotchas (hard-won — these are the difference between working and silently broken)

- **Every site is a git submodule.** `.git` is a *file*, not a directory — any check must use
  `[[ -e .git ]]`, not `[[ -d .git ]]`. And inside the worker container, plain `git` can't resolve the
  submodule gitdir, so git-derived checks behave differently than on the host.
- **The engineer's `run-engineer.sh` ships fixes with `git add -A`.** On a site with pre-existing
  uncommitted WIP that means it would sweep unrelated work into a deploy. Do **not** run the engineer
  on a dirty tree; pause it with `touch ops/.engineer-paused` (monitor-only) until the tree is clean.
- **Worker Node must satisfy the site's Astro.** Astro 6 needs Node ≥22; if `Dockerfile.worker` is
  `node:20-alpine` the engineer's `npm run build` gate fails every run (CF Workers Builds uses its own
  Node, so production is fine — only the local gate breaks). Bump the base image + rebuild.
- **Bind-mount git noise.** The worker runs as a different uid over a bind-mount, so git can report
  exec-bit-only and racy-mtime "changes," and untracked tooling dirs (`.claude/`) as dirty. The
  engineer's dirty-SOURCE check is hardened for this (index refresh + `core.fileMode=false` + exclude
  `ops/logs`, `ops/board`, `ops/.locks`, `ops/facts.yaml`, `.deploy-needed`, `.claude/`) and lists the
  offending files so a real `⚠ N uncommitted src` is actionable. If a new noisy path appears, extend
  that exclusion list in `engineer-check.sh.tmpl`.
- **Rule 0 — bash-driven roles always get an explicit dispatch branch**, even on a generic
  `claude -p` dispatcher, or they get run as a one-shot prompt and skip their whole mechanical sweep.
  See WIRING.md Step 6.
- **Don't double-post Slack.** A `self_notifies: true` role (engineer) must stay out of
  `run-role.sh`'s success-notify allowlist.
- **No-deploy roles file tasks, full stop.** affiliate-editor / seo-analyst must never edit
  `affiliate.ts`, `_redirects`, content, or touch `.deploy-needed`.

## Relationship to the cron-manager

`tools/cron-manager` is the loopback control panel (port 4753) that views/pauses/resumes/edits every
site's cron jobs at *runtime*. This skill is about authoring/installing the roles; the cron-manager is
about operating them after they exist. They meet at the **kill-switch flag**: `run-worker.sh` no-ops a
role immediately if `ops/.<role>-disabled` exists (bind-mounted, no rebuild needed), and the panel's
enable/disable buttons toggle that same flag. For panel bugs, pause semantics, or "disabled but still
firing," use the **cron-manager-maintenance** skill instead.

## Where to read more
- `tools/cron-roles/WIRING.md` — the install engine, step by step (read for any install/wiring work).
- `tools/cron-roles/handoff-protocol.md` — awareness generation + the absent-role fallback.
- `tools/cron-roles/README.md` — stamp-once model + add-archetype recipe.
- `reference_cron_role_family.md` (memory) — the family's origin, the two proven installs, the gotchas.
- A site's `ops/` — `roles/`, `scripts/{run-role,run-worker,run-engineer,notify-slack}.sh`,
  `docker/{crontab.docker,Dockerfile.worker}`, `tasks/{backlog,in-progress,done}/`, `board/`.
