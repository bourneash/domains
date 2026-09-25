---
ticket_id: 2026-09-25-0daynews-com-watchdog-max-turns-30-is-1-short-for-complex-in
status: applied
title: 0daynews.com watchdog MAX_TURNS=30 is 1 short for complex incident repairs
created: 2026-09-25
decided: 2026-09-25
finding_class: max-turns-cap-too-low
dedupe_key: 9314a9cd5dd219ea
scope: site
sites: [0daynews.com]
role: watchdog
window_from: 2026-09-19
window_to: 2026-09-25
measured_cost_usd: 9.37
estimated_savings_usd_per_day: 0.46
risk: low
verified_current_code: true
verified_git_check: "Read sites/0daynews.com/ops/scripts/watchdog.sh directly. Line 39 shows MAX_TURNS=\"${WATCHDOG_MAX_TURNS:-30}\" — unchanged. Watchdog logs for 2026-09-24 show 4 consecutive failures all at turns=31/30, on incident classes cf-build-fail, smoke-fail, and deploy-stuck. No queue depth concern: watchdog is event-driven (works on open incidents only); all 4 incidents are now resolved. Incidents are not queued work — they are emitted on detection and the watchdog has no backlog."
evidence_files: ["sites/0daynews.com/ops/scripts/watchdog.sh:39"]
applied_commit: 106beb84b
decided_by: Codex (user-requested fix)
decision_note: 0daynews.com watchdog default raised 30 to 35 and an eight-turn reporting checkpoint added; bash -n passed; site commit 106beb84b pushed to main.
---

## Problem

`watchdog.sh:39` sets `MAX_TURNS="${WATCHDOG_MAX_TURNS:-30}"`. The watchdog logs for 2026-09-24 show 4 consecutive repair passes all hitting the cap at exactly 31/30 turns — the model needs one turn more than the budget allows.

This happened on three incident classes: `cf-build-fail`, `smoke-fail`, and `deploy-stuck`. Each truncated pass costs ~$0.85 and produces no output (the repair script's wrapper archives a 0-byte partial and retries). With a 20-minute cooldown and 3-attempt cap, each incident that triggers this pattern burns 2–3 full capped passes before either resolving via retry or escalating.

Over the 2-day active window: 4 max-turns failures = $3.60 wasted; $4.60 total attributed as max_turns_wasted_usd in the packet.

## Proposed change

In `sites/0daynews.com/ops/scripts/watchdog.sh` line 39, raise the default from 30 to 35:

```bash
# Before
MAX_TURNS="${WATCHDOG_MAX_TURNS:-30}"

# After
MAX_TURNS="${WATCHDOG_MAX_TURNS:-35}"
```

Five turns of headroom above the observed 31-turn waterline. The cap still protects against runaway passes; it just stops cutting off a repair that's one turn from finishing.

## Risk

Low — mechanical change to a numeric constant. The watchdog prompt is unchanged; model behaviour is unchanged. The extra 5 turns only fire when the model has not yet emitted its output contract, which is exactly the case we want to unblock. At $0.85/call, 5 extra turns costs at most a few cents of additional token spend per call even in the worst case.

## Verification

Confirmed: `sites/0daynews.com/ops/scripts/watchdog.sh:39` reads `MAX_TURNS="${WATCHDOG_MAX_TURNS:-30}"` in the current working tree. Watchdog logs for 2026-09-24 confirm the 31/30 pattern across 4 separate passes. All incidents are now resolved; this is hardening for the next cluster.
