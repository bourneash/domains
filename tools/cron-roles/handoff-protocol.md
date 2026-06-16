# Handoff Protocol — how roles pass work to each other

Roles communicate ONLY through the task board: a file in `ops/tasks/backlog/`
with front-matter `assigned_role: <role>` and `type: <type>`.

## Canonical edges

| From | Hands to | When | Task `type` |
|---|---|---|---|
| content-writer  | engineer       | engineering problem noticed mid-edit | engineering |
| affiliate-editor| engineer       | broken cloak/redirect (/go/ 404)     | engineering |
| affiliate-editor| content-writer | stale product claim inside a guide   | content |
| seo-analyst     | content-writer | new/refresh content opportunity      | content / refresh |
| seo-analyst     | engineer       | technical SEO (canonical, sitemap)   | engineering |
| planner         | (all)          | dispatches; reads the whole board    | * |
| engineer        | (sink)         | everyone escalates here              | engineering |

## Absent-role fallback (MECHANICAL — never assume a role exists)

Before emitting a handoff instruction, the installer inventories the site:

```bash
ls "$TARGET/ops/roles/" | sed 's/\.md$//'
```

For each outgoing edge whose target role is NOT in that inventory, the awareness
block degrades the instruction to: **post a Slack alert via
`ops/scripts/notify-slack.sh` AND file a `type:<x>` task with
`assigned_role: human-triage`** — never a dangling reference to a non-existent role.

## Generating the awareness block (called by WIRING.md Steps 4 & 10)

1. Inventory existing roles (command above) → `PRESENT[]`.
2. For the role being installed, look up its outgoing edges in the table.
3. For each edge: if target ∈ PRESENT → emit the "file `assigned_role: <target>`"
   line; else → emit the fallback line.
4. Render the result under a `## Handing off work` section in the new role's body.
5. Bidirectional (Step 10): for each sibling already present that has an edge
   TO the new role, append/refresh a one-line "…and `<newrole>` now exists, file
   `assigned_role: <newrole>` for <type>" note under that sibling's
   `## Handing off work` section. Idempotent (skip if the exact line exists).

## Pure-pipeline exclusions (do NOT inject awareness blocks into these)

Some roles are non-agentic data-pipeline steps driven by Python/scripts, not by a
`claude -p` reading a role body — they cannot read or act on a handoff stanza. When
running Step 10's bidirectional pass, SKIP role files whose name matches a known
pipeline role: `brief-builder`, `reading-generator`, `signal-writer` (and any role
whose body declares itself a non-agentic pipeline step). Injecting an awareness block
into these is noise at best. The role being INSTALLED still gets its own awareness
block (Step 4) normally — this exclusion only governs which SIBLINGS get edited in
Step 10.

## The `human-triage` sink

`assigned_role: human-triage` is the universal fallback owner. No cron role picks
these up — they are a durable, greppable record for the human operator (Jesse) to
triage from the board, paired with the Slack alert that fires at the same time. Use it
whenever an outgoing edge's target role does not exist on the site. A site that later
installs the missing role does NOT auto-reassign existing human-triage tasks; that's
fine — stamp-once, no back-sync.
