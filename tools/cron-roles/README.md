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
