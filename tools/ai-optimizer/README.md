# ai-optimizer — fleet AI-cost finding queue

A board for **AI-spend findings**: an analyst files them, a human approves or
denies them in the Fleet Dashboard, and only then does anything get changed.

```
queue/proposed/   filed by the analyst, awaiting a human decision
queue/approved/   human said do it — an implementer may pick it up
queue/applied/    implemented (records the commit)
queue/rejected/   human said no. This finding is never re-filed.
queue/deferred/   "let it sit" — not now, but don't suppress it forever
```

Fleet-level, not per-site (unlike `ops/tasks/` and `ops/guide-queue/`), because
findings routinely span several sites — one verbose-build-output fix applied to
five at once. A per-site board has nowhere to put that.

## Why the evidence bar exists

This queue is fed by an agent reading token-usage telemetry, and **telemetry
alone is a proven liar about what is currently broken.** In the 2026-08-25
audit that motivated this tool, the analyst twice reported a role as an active
cost bug off a 14-day aggregate when the fix had already landed *inside that
window*:

| Reported as | Reality |
|---|---|
| `0daynews.com` page-designer, expensive AI role | Replaced by a deterministic script 2026-08-19. Every call in the window predated the cutover. |
| `newmomshop.com` engineer, 391 calls / $36, unconditional | Gated behind bash pre-checks 2026-08-19 — 862 calls before, 7 after. |

Both would have become tickets. An implementer acting on either would have
"fixed" already-fixed code. So `validate()` **rejects** a ticket unless the
analyst actually went and looked:

- `verified_current_code: true` — you read the *live* role/script and the issue
  is still there.
- `verified_git_check` — what git history you checked, in words.
- `evidence_files` — non-empty `path:line` refs.
- `measured_cost_usd` > 0 and a `window_from`/`window_to` — no vague findings.
- `risk` — `low` / `medium` / `high`.

Filing fails loudly (exit 3) if any of that is missing. That is the point.

## Dedup

`dedupe_key = sha256(finding_class | scope | sites | role)` — deliberately not
the title (an agent rewords it every run) or the dollar figure (drifts daily).
A finding matching **any** existing ticket, *including a rejected one*, is
suppressed. A denied ticket must not come back every morning.

## Usage

```bash
python3 tools/ai-optimizer/cli.py list [--status proposed] [--json]
python3 tools/ai-optimizer/cli.py show <file.md>
python3 tools/ai-optimizer/cli.py file --json-file finding.json   # analyst
python3 tools/ai-optimizer/cli.py move <file.md> --to approved --note "..."
```

Dashboard: **Growth → AI Optimizer**. The tab is decide-only — there is no
"new ticket" button, because filing must go through the validation above.

Allowed transitions from the dashboard:

```
proposed → approved | rejected | deferred
deferred → approved | rejected
approved → applied  | rejected | deferred
rejected → deferred
applied  → (terminal)
```

Nothing jumps straight from `proposed` to `applied`.

## Format note (why the parser is picky)

Tickets are flat frontmatter — **one line per key**, flow-style lists. Both
Python (`lib/ai_optimizer.py`) and Node (`fleet-dashboard/server/aioptimizer.js`)
write these files, and the Python side uses a hand-rolled flat parser rather
than PyYAML (the fleet's worker containers mostly lack it — same constraint
`tools/task-budget` documents).

js-yaml does **not** stay in that subset by default: with folding on it emits
`>-` block scalars and block-style lists, and the Python parser silently drops
both. During bring-up that ate `sites` and `evidence_files` off a real ticket
after one approve round-trip. The Node dump is pinned to
`lineWidth: -1, flowLevel: 1`, the Python parser now *raises* on a block scalar
instead of returning `">-"`, and `aioptimizer.crosslang.test.js` fails if either
regresses.

## Not built yet

- **The daily analyst role** — a cron role that runs the audit and files
  findings. Format proves out first, against hand-filed real tickets.
- **The implementer** — picks up `approved/` and applies the fix. When built it
  should be **canary-first**: apply to one site, verify, then require a
  *second* approval to fan out. Blast radius of a fleet-wide auto-apply is the
  reason the June 2026 auto-rollout tool was rejected; an approval gate changes
  that, a blank cheque does not.
