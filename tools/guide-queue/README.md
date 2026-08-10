# guide-queue

Fleet-shared library backing the guide-writing pipeline
(`tools/cron-roles/archetypes/{guide-idea-seeder,guide-writer,guide-publisher}`):
a per-site file-kanban of guide ideas moving through
`ideas/ → drafted/ → ready/ → released/` (+ `rejected/`), surfaced and
manageable in the Fleet Dashboard's Guides tab.

Built 2026-08-10, first installed on reviewtattoo.com.

## Why this exists

`tools/cron-roles`' `content-writer` archetype is for one-off tasks worked
off a generic `ops/tasks/` board. This is for a different shape of work:
a standing backlog of guide *ideas* that get written ahead of a preview
step and released on a configurable cadence — so a burst of new article
ideas doesn't all land on the site the same day (see the reviewtattoo
guide-queue design conversation, 2026-08-10: publishing a week's worth of
guides in one day reads as either an SEO trick or a content dump; a steady
cadence reads as an active editorial site and lets each new guide
cross-link into ones already indexed).

## Layout

```
tools/guide-queue/
  lib/
    guide_queue.py   # parse/serialize/list/move/add-idea — the whole model
    cli.py            # thin CLI wrapper, JSON in/out, for the bash role scripts
```

Mounted read-only into a site's worker container the same way
`tools/task-budget` already is (see docker-compose.yml's
`.monorepo-tools` bind) — no per-site copy, one library for the fleet.

## Item shape

`ops/guide-queue/<status>/<id>.md` per site — YAML frontmatter + markdown
body, same convention as `ops/tasks/`. See `guide_queue.py`'s module
docstring and `QUEUE_FIELDS` for the exact frontmatter contract (which keys
are queue-only vs. real content frontmatter that ships as-is to the site).

## Installing on a new site

Not yet wrapped in a `domains-cron-role-guide-*` installer skill (only
reviewtattoo.com is installed as of 2026-08-10) — follow
`tools/cron-roles/WIRING.md`'s generic steps against the three archetypes,
reading each `meta.yml`'s `placeholder_detection` block carefully. The one
step that is NOT mechanical substitution: `generate-guide-images.py`'s
`BASE_STYLE`/`SUBJECTS` dict is a real per-site art-direction decision (read
the target site's palette/design system and hand-write a new recipe) — see
the comment block in `archetypes/guide-writer/meta.yml`.

## Dashboard

`tools/fleet-dashboard`'s Guides tab (`server/guideQueue.js`) reads/writes
this same directory tree directly — list/preview/move/reject/accept, plus
editing a site's `guide_cadence_days` / `guide_ideas_min`
(`ops/tracked.yaml`'s `manual:` block).
