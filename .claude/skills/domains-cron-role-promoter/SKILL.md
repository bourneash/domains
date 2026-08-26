---
name: domains-cron-role-promoter
description: Install (or maintain) the autonomous Promoter cron role on a portfolio site under /home/jesse/projects/domains/sites/ that has no editorial content pipeline (a game, a tool, a static brand page). Twice-weekly (Tue/Fri), it writes short evergreen items about the SITE ITSELF — feature spotlights, engagement questions, CTAs, real milestones — into ops/social/spotlight/*.md, which tools/social-hub drafts posts from directly (no articles/guides needed). Use when the user asks to "give <site> a writer" for a site with no content collection, "install the promoter role", "add a role that promotes the site itself", or "set up social writers for the sites with no articles".
---

# Install the Promoter cron role

Archetype library: `tools/cron-roles/archetypes/promoter/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `promoter`. Awareness: `tools/cron-roles/handoff-protocol.md`.

## When this is the right role (vs. content-writer)

Use `promoter`, not `content-writer`, when the site has no article/guide/
product content model at all — check `ls site/src/content/` and the site's
`CLAUDE.md`. If the site publishes real content, install `content-writer`
(or `guide-writer`) instead; `promoter` never writes site content, only
promotional copy about the site.

## Pre-req: wire the site's `hub.yaml` to read the spotlight collection

`tools/social-hub` only drafts from what a site's `ops/social/hub.yaml`
tells it to read. Before (or right after) installing the role, add this
`sources:` block to the site's `ops/social/hub.yaml` — create the file with
`enabled: true` first if it doesn't exist yet (see any existing site's
hub.yaml for the rest of the required fields — cadence, approval, ai, voice):

```yaml
sources:
  collections:
    - name: spotlight
      glob: "ops/social/spotlight/*.md"
      url_template: "{url}"     # each item's own frontmatter `url:` field
```

## Step-by-step

1. Run WIRING.md Steps 1–13 against the target site, reading this
   archetype's `meta.yml` for schedule/model/placeholders. Resolve
   `SITE_DESCRIPTION` carefully (Step 2's generic detection doesn't cover
   it) — pull the real one-sentence description from `CLAUDE.md` /
   `INCOME_PLAN.md` / `package.json`; a vague description here produces
   generic, off-brand spotlights.
2. `mkdir -p ops/social/spotlight/` and seed 1–2 real starter items (not
   filler — a genuine feature spotlight and one engagement question) so the
   hub has something to draft from before the role's first scheduled run.
3. `meta.deploy: false` — this role never touches `site/`, so `run-role.sh`
   should NOT set `.deploy-needed` after it runs. If the site's dispatcher
   assumes every role deploys, confirm this role is excluded from that
   assumption.
4. `meta.worker_deps` is empty — Step 8 skipped. Step 11's rebuild is still
   mandatory (crontab bake).
5. **Voice stub:** like content-writer, the installed `ops/roles/promoter.md`
   ships a `## Voice rules (TUNE PER SITE)` stub. Fill it from the site's
   `CLAUDE.md`/`DESIGN_SYSTEM.md` before the role goes live — an unfilled
   stub produces generic, unbranded spotlights.

Maintain mode: if `ops/roles/promoter.md` already exists, WIRING.md runs
Steps 4, 10, 11 only — never destroy operator-tuned voice prose.
