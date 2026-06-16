---
name: domains-cron-role-content-writer
description: Install (or maintain) the autonomous Content Writer cron role on any portfolio site under /home/jesse/projects/domains/sites/. The content-writer runs every Saturday at 7am, picks the highest-priority type:content or type:refresh task from the backlog, writes or refreshes one piece of content per run, runs the build gate, commits, and signals the harness to queue a deploy. It owns type:content and type:refresh tasks and produces type:engineering handoffs when a build or redirect bug is noticed mid-edit. Use when the user asks to "add the content writer", "install the writer role", "wire content publishing", "give <site> a content writer", "install <site> content writer", or "add autonomous writing to <site>".
---

# Install the Content Writer cron role

Archetype library: `tools/cron-roles/archetypes/content-writer/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `content-writer`. Awareness: `tools/cron-roles/handoff-protocol.md`.

1. Run WIRING.md Steps 1–13 against the target site, reading this archetype's
   `meta.yml` for schedule/model/worker_deps/placeholders/gitignore.
   Content-writer-specific placeholders not covered by WIRING.md's generic
   Step 2 detection — resolve them using the `placeholder_detection` hints in
   `meta.yml`:
   - `CONTENT_COLLECTIONS`: enumerate `site/src/content/` subdirectories; describe
     the site's actual collections (e.g. `guides + styles`, or `articles + briefings`)
   - `GO_PREFIX`: confirm from `site/public/_redirects` (default `/go/`)
2. This role is an LLM role (`meta.model: claude-sonnet-4-6`, not bash-driven),
   so WIRING.md Step 6 uses the **generic/LLM dispatch path**: pass `--model` from
   `meta.model` (do NOT write a bash-runner branch like the engineer). Add the role
   to run-role.sh's Slack-notify allowlist (`meta.self_notifies: false`).
3. This role OWNS `type: content` and `type: refresh` tasks. It PRODUCES one
   outgoing handoff type:
   - `type: engineering` → build failure or broken `{{GO_PREFIX}}` redirect noticed
     mid-edit (to the engineer role, or `human-triage` fallback per
     handoff-protocol.md if no engineer exists)
   The `<!-- AWARENESS-BLOCK -->` marker in `role.md.tmpl` is filled per-site by
   WIRING.md Step 4 from handoff-protocol.md — do NOT hardcode role destinations.
4. `meta.worker_deps` is empty — no Dockerfile.worker changes needed (Step 8
   skipped). The rebuild in Step 11 is still mandatory: the new crontab line must
   be baked into the cron image (sinderella guard).
5. **IMPORTANT — voice stub:** the installed `ops/roles/content-writer.md` ships
   with a `## Writing voice (TUNE PER SITE)` section that is a generic stub. After
   install, the operator MUST fill this section with the site's actual voice before
   the role runs. Point the operator at the site's `CLAUDE.md` and `DESIGN_SYSTEM.md`
   (if it exists) as the source of truth for voice. A role that runs with the stub
   in place will produce generic, un-branded content — this is a first-class post-
   install action, not an optional polish step.

Maintain mode: if `ops/roles/content-writer.md` already exists, WIRING.md runs
Steps 4, 10, 11 only (refresh body + awareness, re-verify) — never destroy operator
edits, especially operator-authored voice prose in the TUNE-PER-SITE section.
