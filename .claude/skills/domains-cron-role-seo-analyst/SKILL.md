---
name: domains-cron-role-seo-analyst
description: Install (or maintain) the autonomous SEO Analyst cron role on any portfolio site under /home/jesse/projects/domains/sites/. The seo-analyst runs every Wednesday at 6am, pulls Google Search Console data, re-pings IndexNow, audits schema/JSON-LD and internal linking, identifies opportunity-zone queries (positions 5-20), and files typed tasks to the backlog for content-writer and engineer to act on. It is a diagnose-only role: it never edits site files, never writes pages, and never deploys. It owns type:seo tasks and produces type:content, type:refresh, and type:engineering handoffs. Use when the user asks to "add the seo analyst", "install seo role", "install <site> seo analyst", "wire SEO monitoring", "add search console analysis to <site>", or "give <site> automated SEO tracking".
---

# Install the SEO Analyst cron role

Archetype library: `tools/cron-roles/archetypes/seo-analyst/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `seo-analyst`. Awareness: `tools/cron-roles/handoff-protocol.md`.

1. Run WIRING.md Steps 1–13 against the target site, reading this archetype's
   `meta.yml` for schedule/model/worker_deps/placeholders/gitignore.
   All seo-analyst placeholders are covered by WIRING.md Step 2's generic detection
   (SITE_NAME from package.json, BASE_URL from CLAUDE.md, SLACK vars from run-role.sh).
   No extra placeholder detection steps needed beyond the standard Step 2 reads.
2. This role is an LLM role (`meta.model: claude-sonnet-4-6`, not bash-driven),
   so WIRING.md Step 6 uses the **generic/LLM dispatch path**: pass `--model` from
   `meta.model` (do NOT write a bash-runner branch like the engineer). Add the role
   to run-role.sh's Slack-notify allowlist (`meta.self_notifies: false`).
3. This role OWNS `type: seo` tasks. It PRODUCES two outgoing handoff types:
   - `type: content` or `type: refresh` → new/refresh content opportunities
     (to the content-writer role, or `human-triage` fallback per handoff-protocol.md
     if no content-writer exists)
   - `type: engineering` → technical SEO issues (broken canonical, sitemap, redirects,
     schema template bugs) (to the engineer role, or `human-triage` fallback if no
     engineer exists)
   The `<!-- AWARENESS-BLOCK -->` marker in `role.md.tmpl` is filled per-site by
   WIRING.md Step 4 from handoff-protocol.md — do NOT hardcode role destinations.
4. `meta.worker_deps` is empty — no Dockerfile.worker changes needed (Step 8
   skipped). The rebuild in Step 11 is still mandatory: the new crontab line must
   be baked into the cron image (sinderella guard).
5. `meta.deploy: false` — the seo-analyst files tasks and commits reports only.
   It never modifies site source, never creates `.deploy-needed`, and never triggers
   the deployer.
6. After install, verify that the `ops/board/` directory exists on the target site
   (needed for seo report output). It is part of standard ops scaffolding; if missing,
   the site is not fully scaffolded — stop and report rather than creating it ad hoc.

Maintain mode: if `ops/roles/seo-analyst.md` already exists, WIRING.md runs
Steps 4, 10, 11 only (refresh body + awareness, re-verify) — never destroy operator
edits, especially site-specific schema audit checks or keyword focus areas.
