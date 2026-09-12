---
name: domains-audit-ai-usage-last-24-hours
description: Audit fleet AI spend over the last 24h (or any window) using tools/ai-usage — cost, tokens, cache-hit ratio, per-site/per-role breakdown, real errors vs false-positive network preflight skips, and efficiency findings (model right-sizing, backlog/cap tuning, local-LLM candidates). Use when asked "how's our AI usage/spend been", "any AI cost issues", "check token usage", "how can we cut AI costs/improve efficiency", or to do a periodic spend review.
---

# Audit fleet AI usage (last 24h)

## 1. Pull the numbers

```bash
cd /home/jesse/projects/domains
python3 tools/ai-usage/aggregate.py --from <YYYY-MM-DD> --to <YYYY-MM-DD>   # markdown, human read
python3 tools/ai-usage/aggregate.py --json --from <YYYY-MM-DD> --to <YYYY-MM-DD> > /tmp/ai_usage.json
```

For "last 24 hours" use today's and yesterday's UTC dates (`--from <yesterday> --to <today>`) —
the ledger is UTC-dated, so this window is a superset of the true last 24h; that's fine for a spend
read. No deps beyond stdlib. Reads every `sites/*/ops/logs/token-usage-*.jsonl` (one line per
`claude -p` invocation, written by `tools/scripts/claude-tracked.sh` — see
[[project_ai_usage_tracking]]).

The markdown output gives you, in order: sites-instrumented count, total calls/errors/cost,
token totals + fleet-wide cache-hit ratio, a "no AI cron role at all" list, a "wired but never
fired" list, then one row per site+role. The JSON has the same data under `summary`, `by_site`,
`by_site_role`, `by_day`, `by_hour`, `by_model`, `by_site_role_model_drift`, and **`alerts`**
(see below) — `by_site_role_model_drift` flags any call whose actual model didn't match what the
role's `run-role.sh`/config requested, which is worth a scan on every run since it means a per-role
model pin (including one you just set) silently isn't taking effect.

## 2. Triage the `alerts` array — don't just eyeball cost

```python
import json
d = json.load(open('/tmp/ai_usage.json'))
from collections import Counter
print(Counter(a['subtype'] for a in d['alerts']))
```

Every alert has a `subtype`. What each one means and what to do:

- **`network_preflight_failed`** — `claude-tracked.sh` curled `api.anthropic.com` before the call,
  it failed, the call was **skipped entirely** (`total_cost_usd: 0.0`, `exit_status: 78`). This is
  the 2026-08-19 DNS-outage guard working as designed, not a real error — the caller's normal
  retry-next-tick logic handles it. Only worth digging into if the *same site+role fires at the
  exact same minute on consecutive days* (checked via that site's own docker cron logs,
  `docker logs --since <local-time> --until <local-time> <site>-cron` — mind the container's TZ,
  usually America/New_York/EDT) — that pattern means something site-specific, not fleet DNS.
  Scattered failures across the day/fleet with no shared window = ordinary transient network
  blips, zero cost, no action needed.
- **`error_max_turns`** — hit the turn cap and errored. Check `requested_max_turns`: if it's an
  unusually low number (e.g. `1`) for a role that does real work, that's very likely a genuine
  misconfiguration, not a fluke — but check *why* the turns are capped that low before "fixing" it.
  `tools/social-hub/src/social_hub/ai.py`'s reply/post path deliberately runs `--max-turns 1|2`
  with empty `--allowedTools` and no `--dangerously-skip-permissions` — that's a security control
  (untrusted mention/reply text reaching the model can't drive a tool call regardless of turn
  budget), not a bug. Bumping the turn count there is safe (it only gives a denied-tool-call
  attempt one more turn to fall back to text) and does not weaken the security invariant, which
  comes from the empty allowedTools + missing skip-permissions flag, not from turns.
- **`success` with a high `num_turns` close to `requested_max_turns`** — not an error, but a
  near-miss; several of these clustered on one role is an early signal the budget needs raising
  before it starts erroring for real (this is exactly the failure mode `tools/ai-optimizer` has
  filed and fixed multiple times — see below).
- **Zero-cost / zero-cache-hit rows in the main table are not automatically bugs.** Before
  flagging one: check whether that role actually goes through the Anthropic API at all.
  `news-writer-local` and any `source-auditor`/`source_auditor.py` role run on local Ollama
  (`glm-4.7-flash` by default, `LOCAL_LLM_BASE_URL`/`LOCAL_LLM_MODEL` env) — zero cache hit ratio
  there is expected, there's no Claude prompt cache to hit, and it should show `total_cost_usd: 0`
  correctly. A single call with `cache_hit: 0.0` from an infrequent role (few calls/day) is usually
  just a cold cache write, not a pattern — only treat "no caching" as a finding if it's a
  high-frequency Claude-API role staying at 0% hit ratio across many calls.

## 3. Check the standing findings queue before filing anything new

`tools/ai-optimizer` is the fleet's cost-finding board — an analyst files evidence-backed tickets,
a human approves/denies, only then does anything change. **Always check it before proposing a fix
yourself** — the finding (or its rejection, with reasoning) may already exist:

```bash
python3 tools/ai-optimizer/cli.py list                       # all tickets + status
python3 tools/ai-optimizer/cli.py show <file.md>              # full evidence + proposed fix
python3 tools/ai-optimizer/cli.py move <file.md> --to approved --note "..."
python3 tools/ai-optimizer/cli.py move <file.md> --to applied --note "<what you changed, path:line>"
```

Queue states: `proposed → approved|rejected|deferred`, `approved → applied|rejected|deferred`,
`rejected → deferred`, `applied` terminal. A ticket in `proposed` is the highest-signal thing to
surface in a usage report — it means the fleet's own telemetry-reading analyst already found and
evidenced something a human hasn't acted on yet. Read `tools/ai-optimizer/README.md` once if you
haven't — it documents *why* the evidence bar is strict (telemetry alone has produced false
positives twice: reporting a role as an active cost bug off a stale aggregate window when the fix
had already landed inside that window).

**Rule inherited from the analyst prompt, apply it yourself too:** before proposing any
throughput/rewrite-cap reduction as a cost fix, check the backlog it feeds first
(`grep -rl '<pending-marker>' <site>/src/content/ | wc -l`, or whatever that role's own pending
state is). Cutting a role's per-run output only saves money if it's keeping up; cutting it while a
backlog exists just converts a cost problem into a correctness problem days-to-weeks later
(exactly what happened to sinderella.org's voice-auditor rewrite cap, 2026-08-29 → 2026-09-11 —
see [[project_ai_usage_tracking]] and the applied ticket
`2026-09-09-sinderella-org-voice-auditor-rewrite-cap-3-is-under-provisio` for the full before/after).
A cap/throughput cut proposed while a backlog exists is `risk: high` territory, never auto-apply.

## 4. Efficiency levers, roughly most → least impactful

1. **Model right-sizing by role shape, not by site.** The fleet already runs `deployer`,
   `guide-idea-seeder`, `guide-publisher`, and `social-poster` on `claude-haiku-4-5-20251001` on
   several sites — that's the established, working pattern, not a novel idea. The dividing line is
   **agentic judgment vs. constrained text generation**:
   - Constrained/text-only roles (empty `--allowedTools`, no tool use possible, e.g.
     `tools/social-hub`'s post/reply drafting) → safe to default to Haiku fleet-wide in one shot,
     there's no reasoning task for a bigger model to earn its cost on. (Done 2026-09-11 for
     social-hub — model now resolved from one central default in
     `tools/social-hub/src/social_hub/ai.py`, per-site `ai.model` config can still override.)
   - Agentic roles with real judgment calls and tool/commit access (e.g. `promoter` — reads the
     task board + CLAUDE.md, decides what's spotlight-worthy, writes files, commits;
     `content-writer`, `engineer`) → **canary on 1-2 low-stakes sites first**, compare output
     quality over a few real runs, then decide on wider rollout. Per
     [[feedback_no_auto_rollout_tool]] Jesse has explicitly rejected blanket auto-rollout for cron
     roles — this stays deliberate/reviewed/canary, not a fleet-wide flip in one commit even when
     the direction is approved.
   - Where the model is set: check `<site>/ops/scripts/run-role.sh`'s per-role case statement
     first (`MODEL="..."` per role — these are **per-site copies that have drifted**, not one
     shared file, so a role-level model change is N separate edits, not one); some roles instead
     have their own dedicated `run-<role>.sh` (may hardcode `--model`); shared-library roles
     (social-hub) resolve model from Python/JS config in `tools/<tool>/`, which usually IS a single
     edit point — check for that first, it's much less work when it exists.
2. **Rewrite/turn caps sized to actual throughput**, not just cost. See `tools/ai-optimizer`'s
   applied tickets for the pattern (several `MAX_TURNS too low` fleet rollouts already landed) —
   verify current backlog before touching either direction.
3. **`[[reference_local_llm_writer_pattern]]`** (hardened Ollama writer, cuts Claude spend to ~$0)
   is proven on broadwayshowgirls.com and sinderella.org's generation pipeline, and exists
   (dormant, kill-switched) on americastrikes.com/saveusfarms.com's `news-writer-local` +
   `source-auditor` roles. The highest-cost `content-writer`/`news-writer` sites in any usage run
   are the natural next candidates for this pattern — check whether the site's voice/quality bar
   tolerates a local model before proposing it (some personas are locked to Sonnet-quality prose).
4. **Cache-hit ratio** — fleet average is normally >99%; a *sustained* low ratio on a
   high-frequency Claude-API role (not local-LLM, not a cold-start single call — see §2) means that
   role's prompt isn't reusing a stable prefix (e.g. rebuilding a large system/context block that
   changes every call instead of once per session) — worth a look at what's actually being
   interpolated into the prompt each time.

## 5. Report shape

Lead with: total cost/calls/tokens for the window, cache-hit ratio, real-error count (excluding
`network_preflight_failed`) vs total. Then: any `proposed` ai-optimizer ticket (surface it, don't
bury it — that's usually the most actionable thing in the report). Then: cost concentration (top
5-6 site+role rows by `$`). Then: anything from §4 that applies. Skip narrating rows that are
fine — a 99%+ cache hit ratio and a clean error list don't need a paragraph each.
