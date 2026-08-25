---
name: domains-cron-role-affiliate-editor
description: RETIRED — the per-site affiliate-editor cron role no longer exists. Affiliate monitoring is now tools/affiliate-sentinel; use the domains-affiliate-sentinel skill instead. This stub exists only so the old name still resolves for anyone who asks to "install the affiliate editor" or "add the affiliate editor role".
---

# Retired — use `domains-affiliate-sentinel`

The per-site `affiliate-editor` cron role was retired on **2026-08-25**. Do not
install it. Its cron line is commented out on all 14 sites that had it, and
`tools/cron-roles/archetypes/affiliate-editor/` is banner-marked retired.

Affiliate monitoring is now **`tools/affiliate-sentinel`** — host-side, daily,
Amazon Creators API for product liveness plus a direct `/go/` fetch for cloak
health, zero tokens on a healthy run.

**→ Load the `domains-affiliate-sentinel` skill.**

Why it was replaced: the old role curled every `/go/` link through to Amazon and
grepped the landed HTML for soft-404 strings. Amazon serves an anti-bot wall to
datacenter IPs, so a large permanent share of every run came back "inconclusive
— Robot Check", and product liveness rode on brittle English marker strings. It
also could not tell the difference between "the product is gone" and "our own
redirect is broken" — the second being where the fleet's worst affiliate bug
actually lived.

`ops/scripts/run-affiliate-editor.sh` is kept **unscheduled** on the sites that
already have it, as a manual fallback for when the Amazon API is unavailable. If
a site does not have it, do not add it.
