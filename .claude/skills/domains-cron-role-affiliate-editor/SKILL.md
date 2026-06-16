---
name: domains-cron-role-affiliate-editor
description: Install (or maintain) the autonomous Affiliate Editor cron role on any portfolio site under /home/jesse/projects/domains/sites/. The affiliate-editor runs every Wednesday at 7am, curl-checks every /go/<id> affiliate cloak link against the live site, classifies results (healthy / soft-404 de-listing / broken redirect / anti-bot wall / out-of-stock), and files typed tasks to the backlog for genuine failures. It is a NO-DEPLOY sentinel: it never edits affiliate.ts, _redirects, or content, and never queues a deploy. Use when the user asks to "add the affiliate editor", "install affiliate link checker", "install affiliate link tester", "add <site> affiliate role", "wire affiliate checking", or "give <site> affiliate link monitoring".
---

# Install the Affiliate Editor cron role

Archetype library: `tools/cron-roles/archetypes/affiliate-editor/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `affiliate-editor`. Awareness: `tools/cron-roles/handoff-protocol.md`.

1. Run WIRING.md Steps 1–13 against the target site, reading this archetype's
   `meta.yml` for schedule/model/worker_deps/placeholders/gitignore.
   Affiliate-editor-specific placeholders not covered by WIRING.md's generic
   Step 2 detection — resolve them using the `placeholder_detection` hints in
   `meta.yml`:
   - `GO_PREFIX`: confirm from `site/public/_redirects` (default `/go/`)
   - `AFFILIATE_TAG`: read from `site/src/lib/affiliate.ts` (e.g. `reviewtattoo-20`)
   - `CONTENT_PATH`: the content directory to grep for referencing pages (varies
     per site — inspect `site/src/content/` or `site/src/pages/` to identify the
     primary content path)
2. This role is a **NO-DEPLOY sentinel**: `meta.deploy: false`. It OWNS
   `type: affiliate` tasks and PRODUCES two outgoing handoff types:
   - `type: content` → dead product / de-listed ASIN (to the content-writer role,
     or `human-triage` fallback per handoff-protocol.md if no content-writer exists)
   - `type: engineering` → broken `/go/<id>` redirect itself (to the engineer role,
     or `human-triage` fallback if no engineer exists)
   The `<!-- AWARENESS-BLOCK -->` marker in `role.md.tmpl` is filled per-site by
   WIRING.md Step 4 from handoff-protocol.md — do NOT hardcode role destinations.
3. This is a normal LLM role (`meta.model: claude-sonnet-4-6`, not bash-driven),
   so WIRING.md Step 6 uses the **generic/LLM dispatch path**: pass `--model` from
   `meta.model` (do NOT write a bash-runner branch like the engineer). Add the role
   to run-role.sh's Slack-notify allowlist (`meta.self_notifies: false`).
4. `meta.worker_deps` is empty — no Dockerfile.worker changes needed (Step 8
   skipped). The rebuild in Step 11 is still mandatory: the new crontab line must
   be baked into the cron image (sinderella guard).

Maintain mode: if `ops/roles/affiliate-editor.md` already exists, WIRING.md runs
Steps 4, 10, 11 only (refresh body + awareness, re-verify) — never destroy operator
edits.
