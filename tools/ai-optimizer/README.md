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

One more rule lives in the analyst prompt rather than in code, because it needs
judgement: **before proposing any throughput reduction, measure the backlog.**
"Make the role do less per run" only saves money when the role is keeping up —
if it is already deferring work, the cut converts a cost problem into a
correctness problem that surfaces weeks later. A throughput cut on a role with
any backlog is `risk: high` (never auto-applied). This rule exists because it
was violated: a ticket proposed halving sinderella's voice-auditor rewrites
while 106 files were pending and the last run had logged "5 deferred (cost
cap)". Human review caught it — which is the last line of defence, not the
intended one.

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

## The full loop (all four parts are live)

```
06:45 ET daily   ai-optimizer-cron.sh
                 └─ analyst.py            ZERO AI: ledger + git before/after
                    └─ excludes roles already fixed mid-window
                    └─ no live candidates?  exits, spends nothing
                 └─ claude -p             verifies live code, FILES tickets
                 └─ Slack                 only if a ticket was actually filed

   you           Fleet Dashboard -> Growth -> AI Optimizer
                 approve / reject / defer.  No deadline; nothing expires.

:11 :31 :51      ai-optimizer-implement.sh
                 └─ picks ONE approved ticket (never risk:high)
                 └─ aborts if the tree is dirty
                 └─ claude -p applies it to ONE canary site + verifies
                 └─ commit, push, bump submodule pointer
                 └─ ticket -> applied (records the commit)
                 └─ multi-site ticket?  files a FAN-OUT ticket
                                        needing a SECOND approval
```

Both jobs are in `tools/fleet-cron/crontab.docker` (jobs 16 and 17).

**Latency you actually see:** a finding appears the morning after it becomes
true. Once you approve, the fix lands within ~20 minutes. A fleet-wide change
needs two approvals — canary first, then fan-out — and the gap between them is
however long you want.

## Guardrails on the implementer

| Guard | Why |
|---|---|
| One ticket per run | Blast radius over throughput |
| One canary site, even for a fleet ticket | Second approval before anything fans out |
| `risk: high` never auto-applies | Left approved, flagged for a human to drive |
| Dirty tree aborts the run | Never mix our change into uncommitted work; keeps revert clean |
| No commit produced → ticket stays `approved` | An abandoned ticket is surfaced, not silently closed |
| Push failure → loud Slack, ticket not marked applied | A local-only commit must not read as shipped |

`AI_IMPL_DRY_RUN=1` picks and logs a ticket without touching anything.

## Kill switches

Two independent pause toggles, in the tab header (Fleet Dashboard -> Growth ->
AI Optimizer):

- **Daily analyst** — off = no new tickets get filed. The board keeps whatever
  is already on it.
- **Implementer** — off = approvals queue up and nothing changes. This is the
  one to hit if the robot is doing something you do not like; approving a
  ticket then becomes purely advisory until you resume it.

They are independent on purpose — pausing filing should not stop you applying
a fix you already approved, and vice versa. Resuming the implementer asks for
confirmation (it is the direction that starts changing code again).

Each job also has a **Run now** button and a last-run stamp (hover it for the
log tail). On-demand runs fire the exact command supercronic does, detached in
the fleet-cron container; both scripts hold an flock, so triggering one while a
scheduled run is in flight is a safe no-op rather than a double run. A paused
job refuses to run on demand — the scripts exit 0 silently on their own
disabled flag, which would otherwise look like a successful run.

Same flag-file convention as a site role's pause, so the CLI still works and
the cron scripts only ever test for existence:

```bash
touch tools/ai-optimizer/.analyst-disabled     # stop filing
touch tools/ai-optimizer/.implement-disabled   # stop applying
```
