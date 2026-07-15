# Fleet-wide affiliate link auditor + auto-resolver

Status: approved (design), 2026-07-15

## Problem

Every site running the `affiliate-editor` role (13 sites: totaljerks, aliencouncil,
americastrikes, broadwayshowgirls, deeppenetrations, reviewtattoo, saveusfarms,
shoptopless, sinderella, ultrarough, weapontester, wetpages, xxxtea) checks its
affiliate links with a bare `curl -sL` inside an LLM agent's Wednesday run
(`ops/roles/affiliate-editor.md`). Two problems:

1. **No browser, no pacing, no VPN.** Amazon increasingly 503s or captcha-walls the
   raw curl request — logged today as "inconclusive — anti-bot wall" and silently
   skipped. A working, humanized, VPN-routed browser driver already exists
   (`tools/creator-connections/cc_lib.py`, "CloakBrowser") but is wired only into the
   Creator Connections campaign scripts, not affiliate auditing.
2. **Every run burns LLM-agent tokens on deterministic work.** curl'ing N products and
   pattern-matching their HTML is not a task that needs a reasoning model in the loop
   — it needs a script. The agent should only spend tokens when there's an actual
   decision to make (what should replace a dead product).

This also surfaced in totaljerks' own audit history: 2 persistently-OOS links
(`acme-kastmaster-chrome`, `mepps-musky-killer`) currently sit in
`ops/state/affiliate-oos.json` with no automated path to resolution.

## Relationship to the 2026-07-02 OOS-handling spec

`docs/superpowers/specs/2026-07-02-affiliate-out-of-stock-handling-design.md`
explicitly scoped out automatic replacement selection ("no new role", registry
`status`/badge fields, human-mediated `content-writer` swaps) and treated
`affiliate-editor`'s no-deploy invariant as non-negotiable. That design was never
implemented (no `status` field, no badge, on either the registry type or
`AffiliateCard.astro`).

This spec **supersedes** that one on both points, per explicit direction: the
resolution agent now does automatic selection *and* commits + merges + deploys
directly. The OOS badge/gray-card mechanism from the old spec is dropped — it existed
to make a multi-week manual escalation visible on-site; with automatic replacement
there's no multi-week limbo state to badge.

## Goals

- Replace the bare-curl check with a paced, CloakBrowser-driven check (browser +
  VPN + humanize, matching the pattern already proven in `cc_lib.py`).
- Zero LLM tokens for the routine "everything's fine" pass — a deterministic script
  does discovery + check + classify. An LLM agent is invoked *only* when a product is
  flagged.
- One shared, config-driven library in `tools/affiliate-audit/`, not per-site copies.
- When a product is flagged (dead ASIN, OOS past grace period, no Prime badge, rating
  below a configurable threshold, or a broken `/go/<id>` redirect), an agent sources a
  same-category replacement, verifies it live via CloakBrowser, edits the registry,
  commits, merges, and deploys — no human gate in the loop.
- Every run posts a Slack summary; every resolution attempt (success or failure) posts
  its own line: what was flagged, what replaced it and why, or that it's still
  outstanding and needs a human.
- Resolution agent runs are turn/attempt-capped — no unbounded exploration loop.
- Fleet-wide from the start, generic by construction; validated end-to-end on
  totaljerks.com before being trusted to run unattended on the other 12.

## Non-goals

- No new on-site rendering state (badges, grayed cards) — a flagged product is either
  fixed automatically or a task sits in backlog; it doesn't linger visibly broken.
- Not touching campaign-only products' sourcing logic (Creator Connections has its own
  pipeline) — `campaignOnly: true` entries are checked for redirect health only, never
  auto-replaced (swapping campaign gear is a contractual/creator relationship, not an
  editorial pick).
- Not building a generic "product research" tool — the resolution agent's search scope
  is Amazon only, scoped to the failing product's existing category.

## Architecture

```
tools/affiliate-audit/                  (new, domains repo — shared code)
  discover.mjs        — tsx script: import <site>/site/src/lib/affiliate.ts,
                         dump PRODUCTS[] as JSON. Generic; reusable by other tools.
  checker.py           — CloakBrowser session (via cc_lib.launch), visits each
                         /go/<id>/ once, paced+jittered between products.
                         Extracts: soft-404 markers, OOS text, Prime badge,
                         star rating, price, final landed URL.
  classify.py           — deterministic verdict per product using config
                         thresholds: OK / DEAD / OOS / NO_PRIME / LOW_RATING /
                         BROKEN_REDIRECT / INCONCLUSIVE (anti-bot — never actionable).
  state.py             — read/write ops/state/affiliate-audit.json (per site),
                         tracks consecutive-run counts per (product, issue-type).
  resolve.py            — invoked only for actionable, grace-period-elapsed
                         verdicts. Spawns the resolution agent (see below),
                         enforces turn/attempt caps, posts Slack outcome.
  config.default.yaml   — fleet defaults (thresholds, pacing, caps).
  run.py                — orchestrator: discover → check → classify → state
                         update → resolve (as needed) → notify. One entrypoint,
                         called per site (`--site totaljerks.com`).

sites/<domain>/ops/
  affiliate-audit.yaml (optional) — per-site config overrides (same schema as
                                     config.default.yaml, merged on top of it).
  state/affiliate-audit.json      — per-site state (git-committed, like the
                                     existing affiliate-oos.json it replaces).
```

### Data flow

```
run.py --site totaljerks.com
  1. discover.mjs  → PRODUCTS[] as JSON (id, category, brand, price, blurb,
                      asin, searchQuery, campaignOnly)
  2. checker.py     → for each product, in random-jittered order, paced
                      12-25s apart: launch CloakBrowser (once, reused across
                      the run), visit /go/<id>/, scrape landed page.
  3. classify.py    → verdict + evidence per product, using merged config
                      (fleet default + site override).
  4. state.py       → bump/reset consecutive-run counters; only verdicts past
                      their configured grace period become "actionable".
  5. for each actionable product:
       resolve.py   → spawn resolution agent (capped turns/attempts) with:
                        - the failing product's full registry entry
                        - its verdict + evidence
                        - CloakBrowser access (search + verify)
                        - a hard budget: N search attempts, then stop
                      Agent either:
                        a) finds + verifies a replacement, edits affiliate.ts,
                           regenerates _redirects, runs the site's smoke
                           validator, commits, merges to main, triggers deploy
                        b) exhausts its budget unresolved → leaves the current
                           product untouched, files
                           ops/tasks/backlog/<date>-affiliate-issue-<slug>.md
       Either way: post one Slack line (resolved: old→new+reason, or
                   outstanding: verdict+evidence+task path).
  6. notify.sh      → one run-summary Slack line (N healthy / N flagged /
                      N resolved / N still outstanding), same format+emoji
                      convention as the current affiliate-editor role.
```

### Config schema (`config.default.yaml`, override via `ops/affiliate-audit.yaml`)

```yaml
checks:
  prime_required: true
  min_rating: 4.0
  oos_grace_runs: 2        # consecutive runs before OOS is actionable
  dead_grace_runs: 1        # a hard soft-404 is actionable immediately
  broken_redirect_grace_runs: 1
pacing:
  min_delay_s: 12
  max_delay_s: 25
resolution:
  max_search_attempts: 3    # candidate replacements tried before giving up
  max_agent_turns: 20       # hard cap passed to the agent invocation
slack:
  channel_env: SLACK_CHANNEL_TOTALJERKS   # per-site, same pattern as smoke.yaml
```

Schema is intentionally generic (not affiliate-specific in naming) so other fleet
tools can read the same per-site config file for their own thresholds later, per your
ask — but this spec only implements the `checks`/`pacing`/`resolution`/`slack` keys.

### State schema (`ops/state/affiliate-audit.json`)

```json
{
  "acme-kastmaster-chrome": {
    "issue": "oos",
    "consecutive_runs": 3,
    "first_seen": "2026-07-01",
    "last_checked": "2026-07-15"
  }
}
```

Replaces `affiliate-oos.json` (OOS-only) with a generalized per-issue-type tracker.

### Resolution agent guardrails

- Hard cap on agent turns (`resolution.max_agent_turns`, default 20) and on candidate
  search attempts (`resolution.max_search_attempts`, default 3) — passed as explicit
  budget in the agent's invocation, not a suggestion in the prompt.
- Every replacement candidate is verified live via CloakBrowser (Prime, in-stock,
  rating) before being written to the registry — the agent never picks blind off a
  search results page.
- On exhausting its budget without a verified candidate, the agent **must** stop,
  leave the existing (broken) entry untouched, file a backlog task, and report
  "outstanding" to Slack — it does not extend its own budget or retry indefinitely.
- Replacement commits run the site's existing `smoke-affiliate` postbuild validator
  (where present) before merge; a validator failure blocks the merge and downgrades
  the outcome to "outstanding" (same as an unresolved search).
- `campaignOnly: true` products are never auto-replaced (see Non-goals) — flagged as
  "outstanding" with a note to route to the Creator Connections owner instead.

## Testing / rollout

1. Build `tools/affiliate-audit/` generically against the shared `AffiliateProduct`
   shape (already consistent across all 13 sites' `affiliate.ts`).
2. **Pilot on totaljerks.com.** Deliberately introduce a synthetic broken entry
   (garbage ASIN or a `searchQuery`-only entry with no real inventory) alongside the
   2 already-flagged real OOS links, and run the full pipeline end-to-end: discovery →
   CloakBrowser check → classification → resolution agent → verified replacement →
   commit/merge/deploy → Slack summary. Confirm the synthetic case resolves and the
   real OOS cases either resolve or correctly report "outstanding" after 3 attempts.
3. Retire totaljerks' LLM-agent-driven Wednesday `affiliate-editor` role once the
   pilot is clean — `run.py` replaces it as the cron entrypoint.
4. Roll to the remaining 12 sites via the same `tools/cron-roles/` archetype-refresh
   process used for other fleet-wide role changes, retiring each site's
   `affiliate-editor` role as its pilot-equivalent check passes.

## Open questions resolved during brainstorming

- **Resolution autonomy:** agent commits, merges, and deploys directly — no PR gate.
  Risk is bounded by (a) live CloakBrowser verification of any candidate before it's
  written, and (b) hard turn/attempt caps forcing a stop-and-report instead of an
  unbounded loop.
- **Rollout order:** built fleet-wide/generic from the start (not totaljerks-specific
  code later generalized), but validated end-to-end on totaljerks first, including
  synthetic broken-link cases, before trusting it unattended elsewhere.
