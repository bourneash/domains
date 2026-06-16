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

## The archetypes

Each was selected as the best existing implementation across the portfolio (scored
against: mechanical clarity, task-board integration, deploy discipline, source-of-truth
rigor, anti-slop guardrails, reusability), then parameterized.

| Archetype | Skill | Kind | Owns → Produces | Schedule | Selected from |
|---|---|---|---|---|---|
| `engineer` | `domains-cron-role-engineer` | bash-driven sink | engineering → — | `0 */4 * * *` | americastrikes |
| `affiliate-editor` | `domains-cron-role-affiliate-editor` | LLM, no-deploy sentinel | affiliate → content, engineering | `0 7 * * 3` | reviewtattoo |
| `content-writer` | `domains-cron-role-content-writer` | LLM, deploy (voice tuned per site) | content, refresh → engineering | `0 7 * * 6` | reviewtattoo |
| `planner` | `domains-cron-role-planner` | LLM dispatcher | ops, planning → * | `0 6 * * 1` | wetpages |
| `seo-analyst` | `domains-cron-role-seo-analyst` | LLM, diagnose-only | seo → content, refresh, engineering | `0 6 * * 3` | wetpages |

Roles hand work to each other ONLY through the task board, and awareness is generated
**dynamically per site** at install time (a role learns which siblings actually exist;
absent targets degrade to a Slack alert + `human-triage` task). See `handoff-protocol.md`.

## Adding a new archetype

1. `mkdir tools/cron-roles/archetypes/<name>/` with `role.md.tmpl` (canonical body,
   `{{UPPERCASE}}` tokens for site-specifics, a `## Handing off work` heading + a single
   `<!-- AWARENESS-BLOCK -->` marker — never hardcode destination roles) and `meta.yml`
   (copy the field set from an existing `meta.yml`: `schedule`, `model`,
   `owns_task_types`, `produces_task_types`, `worker_deps`, `needs_rebuild_verify`,
   `self_notifies`, `deploy`, `scripts`, `gitignore`, `placeholders`,
   `placeholder_detection`). Add `scripts/*.tmpl` only if the role needs helper scripts.
2. Add a thin `.claude/skills/domains-cron-role-<name>/SKILL.md` that points at `WIRING.md`
   with `<name>` and does NOT inline the steps (copy an existing skill's shape).
3. Dry-stamp validate: substitute sample placeholder values and confirm zero `{{}}` remain,
   the awareness marker is present once, and `meta.yml` parses.

If a role is **bash-driven** (`model: none` + its own runner in `scripts`), WIRING Step 6
"Rule 0" applies — it gets an explicit dispatch branch even on generic-dispatcher sites.
