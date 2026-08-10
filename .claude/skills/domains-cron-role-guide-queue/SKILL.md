---
name: domains-cron-role-guide-queue
description: Install (or maintain) the autonomous Guide Queue pipeline on any portfolio site under /home/jesse/projects/domains/sites/ — three cron roles (guide-idea-seeder, guide-writer, guide-publisher) that seed guide ideas, write+illustrate them as drafts, and release them onto the live site on a configurable cadence, all previewable/editable via the Fleet Dashboard's Guides tab. Use when the user asks to "add the guide writer", "install guide queue", "set up staggered guide releases", "give <site> a guide pipeline", or "add autonomous guide writing to <site>".
---

# Install the Guide Queue pipeline

Archetype library: `tools/cron-roles/archetypes/guide-idea-seeder/`,
`guide-writer/`, `guide-publisher/`. Shared lib: `tools/guide-queue/`.
Mechanical procedure: **follow `tools/cron-roles/WIRING.md`**, once per
archetype (`<name>` = each of the three), reading each one's `meta.yml`.
Awareness: `tools/cron-roles/handoff-protocol.md`.

## 0. Before touching any files — confirm the target site's content model

**Do not assume reviewtattoo.com's shape is universal.** reviewtattoo's
`guides` collection is flat markdown+frontmatter (title/description/
category/faq/body) — the simple case. The first other site this was tried
on (shoptopless.com, 2026-08-10) turned out to have its "guides" as
hand-coded `.astro` pages with structured cross-sell blocks
(`GearStrip` components pulling curated product picks per section), not a
markdown collection at all — writing flat prose into that site would have
produced guides with none of the product cross-sell UX its existing guides
have, or worse, an AI-authored role generating raw `.astro`/TSX for every
new guide (fragile, breaks the build on a syntax slip).

**Before designing the writer role's output schema, check:**
1. Does `site/src/content/` already have a `guides`/`articles` collection?
   If yes and it's flat markdown — this is the simple case, mirror
   reviewtattoo's install directly.
2. If guides are hand-coded pages (grep `site/src/pages` for a guide-shaped
   template, check `site/src/components` for a `*Hero`/`*Guide*` component) —
   this is the shoptopless case. Do NOT wire the writer to generate raw
   `.astro`. Instead: design a content collection whose schema captures
   whatever structure the existing pages have (e.g. a `sections[]` array,
   each optionally naming product picks by slug via `reference('products')`),
   build ONE shared template that renders any collection entry into that same
   visual shape, migrate the existing hand-coded guides into the collection,
   THEN install the pipeline against it. This is real site-architecture work,
   not a mechanical install — say so explicitly before starting it, the
   scope is materially bigger than the simple case.
3. Either way, check for an EXISTING hero/card image convention
   (`grep -rl` for something `*IconMap*`/`*heroImages*`-shaped, and check
   `ops/prompts/` for a style-lock doc) before wiring
   `generate-guide-images.py`. reviewtattoo already had one
   (`guideIconMap` + `ops/prompts/guide-cards/primer.md`) that the first
   install pass missed and had to redo — don't repeat that. If the site has
   no image convention at all, this is where you introduce one (matching
   its existing design tokens/palette), same as reviewtattoo's install did.

## 1. Install the three archetypes

Run WIRING.md Steps 1–13 against the target site for each of
`guide-idea-seeder`, `guide-writer`, `guide-publisher` in turn, reading each
one's `meta.yml` for schedule/model/worker_deps/placeholders. Resolve
`generate-guide-images.py`'s `BASE_STYLE`/`SUBJECTS` per `guide-writer`'s
`meta.yml` note — this is a hand-written art-direction step, not
placeholder substitution.

**Dispatch shape (a third pattern, distinct from content-writer's plain LLM
dispatch and deployer's pure cron-direct):**
- `guide-idea-seeder` and `guide-writer` are **worker-dispatched but
  bash-gated** — like `engineer`, they need a `run-role.sh` branch that
  runs a self-contained script (`run-guide-seeder.sh` / `run-guide-writer.sh`)
  which does its own cheap check and invokes Claude only when there's real
  work. WIRING.md Step 6 needs the bash-runner branch shape (mirror
  `engineer`'s branch in `run-role.sh`), not the generic `--model` LLM path.
- `guide-publisher` is **cron-direct**, exactly like `deployer`/`watchdog` —
  no `run-role.sh` branch at all, invoked straight from `crontab.docker`.
  It never touches Claude. When it has real work (a release is due), it
  spins the worker container directly
  (`docker compose run --rm --entrypoint bash worker ops/scripts/guide-publish.sh`)
  for the parts that need node/npm (the build gate) — same split as
  `deploy.sh`/`run-deployer.sh`.

## 2. media-gen reachability

`guide-writer` calls `tools/media-gen` over `host.docker.internal:4780`.
Add `extra_hosts: ["host.docker.internal:host-gateway"]` to the site's
`docker-compose.yml` worker service if it's not already there (check
sibling sites using host-Ollama for the same pattern first). media-gen
itself binds `0.0.0.0` and self-restricts via a bridge-allowlist middleware
that enumerates every `docker0`/`br-*` interface — this already works for
any site's own compose project network, no per-site media-gen change
needed (fixed 2026-08-10, see `tools/media-gen/src/media_gen/api.py`).

## 3. Config

`ops/tracked.yaml`'s `manual.guide_cadence_days` (default 5) and
`manual.guide_ideas_min` (default 3) — add both, editable later via the
Fleet Dashboard Guides tab's cadence widget.

## 4. Dockerfile.worker deps

`guide_queue.py` needs PyYAML; `generate-guide-images.py` needs Pillow.
`RUN pip3 install --break-system-packages --no-cache-dir pyyaml Pillow` —
check if the site's Dockerfile.worker already has this line (reviewtattoo
does) before adding a duplicate.

## 5. Seed + verify

Seed at least 3 real ideas (not placeholders) via
`python3 tools/guide-queue/lib/cli.py add-idea`, then run the full chain
once for real before calling the install done: `guide-writer` (real Claude
call + real image gen), promote to `ready`, `guide-publisher` (real build
gate + commit + push + `.deploy-needed`), then the site's existing
deployer role. Confirm the images actually render on the live page — grep
the built HTML for the image path, don't just trust the frontmatter field
exists (see step 0.3 — a mismatched convention produces images that exist
on disk but never render).

Maintain mode: if the three roles already exist, WIRING.md runs Steps 4,
10, 11 only per archetype — never destroy operator edits (especially a
hand-tuned `SUBJECTS` dict in `generate-guide-images.py` or a customized
collection schema).
