---
name: domains-cron-role-promoter
description: Install (or maintain) the autonomous Promoter cron role on a portfolio site under /home/jesse/projects/domains/sites/. Fleet-wide role, not just content-less sites — installs ADDITIVELY alongside any existing content-writer/guide-writer/news-writer. Twice-weekly (Tue/Fri), it writes short evergreen items about the SITE ITSELF — feature spotlights, engagement questions, CTAs, real milestones — into ops/social/spotlight/*.md, which tools/social-hub drafts posts from directly via a second `sources.collections` entry (no articles/guides needed, and existing article sources are left untouched). Use when the user asks to "give <site> a writer" for self-promotion, "install the promoter role", "add a role that promotes the site itself", "set up social writers for the fleet", or "add self-promotion posts to <site>".
---

# Install the Promoter cron role

Archetype library: `tools/cron-roles/archetypes/promoter/`
Mechanical procedure: **follow `tools/cron-roles/WIRING.md` exactly**, with
`<name>` = `promoter`. Awareness: `tools/cron-roles/handoff-protocol.md`.

## `promoter` vs. `content-writer`/`guide-writer`/`news-writer`

Not either/or. `promoter` is a standing fleet-wide addition — install it on
every site regardless of whether an editorial writer already exists there.
It never writes site content (articles/guides/pages) and never competes
with an existing writer's task types or content collection — it only adds
self-promotion copy in its own lane (`ops/social/spotlight/`). If a site has
no editorial writer at all, `promoter` is *also* the only thing giving
social-hub something to post — but that's a side effect of it being
additive everywhere, not a special case.

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

**CRITICAL — read `tools/social-hub/src/social_hub/sources.py::discover()`
before touching any site's `hub.yaml`.** The three source styles are NOT
additive with each other — `discover()` tries `collections` first, and if
that list is non-empty it NEVER falls through to `globs` or the built-in
default scan. Concretely:

- **Site's `hub.yaml` already has `sources: collections: [...]`** (e.g.
  amputeenews, allthingsmasonic) — safe to just append a `spotlight` entry
  to that existing list. Both entries are `collections`, both get read.
- **Site's `hub.yaml` has `sources: globs: [...]`** (e.g. saveusfarms,
  broadwayshowgirls) or **has no `sources:` block at all** (relying on the
  built-in default scan of `site/src/content/articles/*.md` — e.g.
  americastrikes, 0daynews) — do **NOT** add a bare `collections: [spotlight]`
  block. Doing so makes `collections` non-empty, which silently DISABLES
  that site's article drafting entirely (the existing `globs`/default-scan
  branch never runs). Instead, convert the article source into an explicit
  `collections` entry in the SAME block, so both are read via the same
  mechanism:

  ```yaml
  sources:
    collections:
      - name: article                              # re-declare the site's real article source —
        glob: "site/src/content/articles/*.md"      # match its actual path/URL pattern, do not guess
        url_template: "https://{domain}/articles/{slug}/"
      - name: spotlight
        glob: "ops/social/spotlight/*.md"
        url_template: "{url}"
  ```

  Confirm the real glob + URL pattern for that site's article collection
  first (check its content-writer/news-writer role body, or an existing
  published article's live URL) — do not assume `/articles/`, several sites
  use `/wire/`, `/posts/`, `/guides/`, etc.
- **Verify after wiring, don't just trust the YAML**: run
  `python3 -c "from social_hub.sources import discover; from social_hub.config import load_site_config; print(len(discover('<domain>', load_site_config('<domain>'))))"`
  (or the hub's own ingest/dry-run CLI if simpler) and confirm the count
  includes BOTH existing articles and the new spotlight items — a count
  that dropped to just the spotlight items means the site's real content
  source got silently cut off.

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
