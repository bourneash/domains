---
name: domains-cron-role-engineer
description: Install (or maintain) the autonomous Engineer cron role on any portfolio site under /home/jesse/projects/domains/sites/. The engineer runs every 4 hours, true-render health-checks the live site (Playwright in-container), sweeps git/Cloudflare/task-board, posts a 👍 Slack heartbeat when healthy+idle (zero tokens), and invokes Sonnet only to fix safe issues behind an authoritative build gate. Use when the user asks to "add/install the engineer role", "give <site> a health-check agent", "wire the engineer", or "update the engineer". Stamps from the americastrikes reference, wires cron + run-role + worker Dockerfile, makes siblings aware, and rebuilds+verifies the cron line is live (the sinderella guard).
---

# Install the Engineer cron role

Archetype library: `tools/cron-roles/archetypes/engineer/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `engineer`. Awareness: `tools/cron-roles/handoff-protocol.md`.

1. Run WIRING.md Steps 1–13 against the target site, reading this archetype's
   `meta.yml` for schedule/model/worker_deps/placeholders/gitignore. Engineer-specific
   placeholders (SITE_BRAND, COLLECTIONS_JSON, STATIC_PAGES_JSON, SITEMAP_PATH) are not
   covered by WIRING.md's generic Step 2 detection — resolve them using the
   `placeholder_detection` hints in `meta.yml` (inspect `site/src/content/` collections
   and the layout/header for the exact on-page brand string).
2. Engineer is the escalation sink: it `owns` `type: engineering` and produces
   no handoffs. Because `meta.self_notifies: true`, do NOT add it to run-role.sh's
   Slack-notify allowlist (run-engineer.sh self-posts — double-post guard).
3. The Step 11 rebuild+verify is MANDATORY — engineer adds chromium to
   Dockerfile.worker, so both `worker` and `cron` images must rebuild. An install
   that skips verify looks done but is dead (sinderella.org, weeks dark).

Maintain mode: if `ops/roles/engineer.md` already exists, WIRING.md runs Steps 4, 10,
11 only (refresh body + awareness, re-verify) — never destroy operator edits.
