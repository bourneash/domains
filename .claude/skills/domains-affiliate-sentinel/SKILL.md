---
name: domains-affiliate-sentinel
description: Operate tools/affiliate-sentinel — the fleet's daily affiliate health check (Amazon Creators API for product liveness + a direct /go/ fetch for cloak health, zero tokens unless an ASIN is confirmed dead, then AI auto-replaces it behind a build gate). Use when asked to check affiliate links, find dead/out-of-stock products, debug a broken /go/ redirect, onboard a site to affiliate monitoring, interpret a sentinel Slack alert, investigate why a product was auto-replaced, run the heal integration test, or fall back to the manual curl/browser checkers when the Amazon API is down. Triggers on "affiliate check", "affiliate sentinel", "dead ASIN", "broken affiliate link", "/go/ 404", "check affiliate links", "affiliate monitoring", "why did the product change", "affiliate Slack alert", "add <site> to affiliate monitoring".
---

# Affiliate sentinel

`tools/affiliate-sentinel` — daily, host crontab `40 3 * * *`, 25 sites.
Full reference: `tools/affiliate-sentinel/README.md`.

## What a run does

Two deterministic checks, **zero AI tokens**:

1. **Is the product real?** Creators API `getItems` on every ASIN in the site's
   registry. Missing is a *suspicion*, never a verdict — it is re-checked with a
   direct fetch of `/dp/<asin>` and must be dead on **two consecutive runs**.
2. **Does our cloak work?** `/go/<id>` fetched on the live site *without
   following the redirect*, asserting the target is Amazon (or the registry's
   declared partner host), carries the right tag, and points at the right ASIN.

AI runs **only** on a `CONFIRMED_DEAD` ASIN — see Heal below.

Everything is discovered from the site at run time. There is no per-site config
and nothing tracked centrally.

## Commands

```sh
# check one site, no writes, no tokens, no Slack
python3 tools/affiliate-sentinel/sentinel.py --site-root sites/<domain> --dry-run --json

# real run for one or more sites (the cron entrypoint)
bash tools/affiliate-sentinel/run-fleet.sh <domain> [<domain> ...]

# check + file tasks but never auto-replace
bash tools/affiliate-sentinel/run-fleet.sh --no-heal <domain>

# tests
python3 tools/affiliate-sentinel/tests/test_sentinel.py   # unit, no network
tools/affiliate-sentinel/tests/integration_heal.sh        # heal, live API + real build, 1 Sonnet turn
```

Logs: `tools/affiliate-sentinel/logs/run-<date>.log` and
`sites/<domain>/ops/logs/affiliate-sentinel-<date>.log`.
Streak state: `sites/<domain>/ops/state/affiliate-sentinel.json`.

## Reading the Slack line

| | meaning | what to do |
|---|---|---|
| ✅ | all clear | nothing |
| ⚠️ | broken cloak, out of stock, access-gated site, or the API was unavailable | check the filed `engineering` task |
| 🚨 | dead product that could NOT be auto-replaced | needs a human pick |
| 🔧 | dead product auto-replaced and deployed | sanity-check the swap |

"N retired" is not a problem: a `/go/` 301 back into the site is how a cloak is
deliberately retired when a product is gone for good.

## Heal (the only token spend)

Code does everything except one judgment call. The model is given candidates the
API already verified and returns an **index, never an ASIN**, so a hallucination
cannot reach the registry. Then: re-verify the chosen ASIN, edit `affiliate.ts`,
sync `_redirects`, fetch the image, scrape rating/reviews, run the site's real
`npm run build` as a gate (revert on failure), commit, queue a deploy.
Cap `MAX_HEALS_PER_RUN = 3` — more than that is a systemic problem, not link rot.

To investigate a swap: `git log` in the site repo for
`affiliate: auto-replace dead product(s) <id>`; the Slack line carries the
model's reason.

## Onboarding a site

1. Dry-run it. "No affiliate registry found" means there is nothing to monitor.
2. **Read the findings and hand-verify a sample before scheduling** —
   `curl -sI https://<domain>/go/<id>/`. On the first fleet sweep, 9 of 20
   findings were checker bugs, not site bugs.
3. Append the domain to the existing host crontab line (do not add a second line).
4. Run it once for real.

## Gotchas

- **Runs host-side, never in a site's cron container.** The Alpine image has no
  `httpx`, and musl cannot run workerd for the build gate.
- **Registry shape varies.** `lib/affiliate.ts` (most), `data/affiliate.ts`,
  `data/affiliates.ts`; keys may be `id`/`slug`, `asin`/`searchOrAsin`/`url`,
  `name`/`label`/`title`. `registry.find_registry()` searches for it.
- **Rating/review count are not available from the API** (the resources are
  accepted but return empty) — they are scraped via CloakBrowser.
- **A site behind password protection** fails every cloak identically; that is
  suppressed to one ⚠️, not N tasks.
- **After a heal, the live site still points at the old ASIN until the deployer
  runs** (every 15 min). A transient ⚠️ in that window is expected.
- **`amz-stats` stands down** on sentinel-managed sites so dead-ASIN tasks are
  not filed twice (`taskfiler.sentinel_owns_site`, 7-day freshness window).

## Fallbacks — manual only, never scheduled

For when the Amazon API is down or the account loses eligibility:

```sh
python3 tools/affiliate-link-check/check_links.py --repo-root sites/<domain> --base-url https://<domain>
python3 tools/affiliate-audit/run.py --site <domain>     # CloakBrowser, heavier
```

If the API is merely unavailable the sentinel degrades on its own: it still
checks cloaks, still posts to Slack, reports ⚠️ "Amazon API unavailable", and
never heals on missing data.

The old per-site `affiliate-editor` cron role is **retired** — do not install it
(`tools/cron-roles/archetypes/affiliate-editor/` is banner-marked).
