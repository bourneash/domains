---
name: domains-cron-role-planner
description: Install (or maintain) the autonomous Planner cron role on any portfolio site under /home/jesse/projects/domains/sites/. The planner runs every Monday at 6am, reads the whole task board (done/in-progress/backlog), re-prioritizes, seeds the week's tasks using a fixed pickup hierarchy, writes a status report to ops/board/, and dispatches tasks to every other role on the site. It owns type:ops and type:planning tasks and can produce any task type — it is the dispatcher for all other roles. Use when the user asks to "add the planner", "install the planner role", "install <site> planner", "wire weekly planning", or "add autonomous task dispatch to <site>".
---

# Install the Planner cron role

Archetype library: `tools/cron-roles/archetypes/planner/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `planner`. Awareness: `tools/cron-roles/handoff-protocol.md`.

1. Run WIRING.md Steps 1–13 against the target site, reading this archetype's
   `meta.yml` for schedule/model/worker_deps/placeholders/gitignore.
   All planner placeholders are covered by WIRING.md Step 2's generic detection
   (SITE_NAME from package.json, BASE_URL from CLAUDE.md, SLACK vars from
   run-role.sh). No extra placeholder detection steps needed.
2. This role is an LLM role (`meta.model: claude-sonnet-4-6`, not bash-driven),
   so WIRING.md Step 6 uses the **generic/LLM dispatch path**: pass `--model` from
   `meta.model` (do NOT write a bash-runner branch like the engineer). Add the role
   to run-role.sh's Slack-notify allowlist (`meta.self_notifies: false`).
3. The planner is the **dispatcher**: it OWNS `type: ops` and `type: planning` tasks
   and PRODUCES any task type for any sibling role. The `<!-- AWARENESS-BLOCK -->` under
   `## The roles you dispatch to` is filled per-site by WIRING.md Step 4 from
   handoff-protocol.md — it enumerates every present sibling and what each owns. Do NOT
   hardcode role names in the template; the marker handles it.
4. `meta.worker_deps` is empty — no Dockerfile.worker changes needed (Step 8
   skipped). The rebuild in Step 11 is still mandatory: the new crontab line must
   be baked into the cron image (sinderella guard).
5. `meta.deploy: false` — the planner files tasks and commits status reports only.
   It never modifies site source, never creates `.deploy-needed`, and never triggers
   the deployer. This is non-negotiable.

Maintain mode: if `ops/roles/planner.md` already exists, WIRING.md runs
Steps 4, 10, 11 only (refresh body + awareness, re-verify) — never destroy operator
edits, especially site-specific strategic priorities or phase notes.
