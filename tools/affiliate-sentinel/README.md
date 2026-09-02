# affiliate-sentinel

API-driven affiliate health check for the domain fleet. Replaces the weekly
`curl`-and-grep sweep (`tools/affiliate-link-check`, the zero-AI bash sentinel)
with two deterministic checks plus an AI heal that fires only on a confirmed
failure.

## Why this replaced the curl sweep

The old sentinel fetched every `/go/<id>` link all the way through to Amazon and
grepped the landed HTML for soft-404 strings. That conflated two unrelated
questions and got both of them half-wrong:

- Amazon serves an anti-bot wall to datacenter IPs, so a large, permanent share
  of every run came back "inconclusive — Robot Check" — a result nobody could
  act on and which no amount of retrying fixed.
- Amazon returns HTTP 200 for dead products, so liveness had to be inferred from
  brittle English marker strings that break whenever Amazon reworks a page.

The Creators API answers "is this product real and in stock" directly, with no
captcha and no string matching. A direct fetch of our own `/go/` route answers
"does our redirect work" — which the API cannot know, and which is where the
fleet's worst affiliate bug actually lived (`_redirects`-based `/go/` silently
404s on Cloudflare Workers).

## What a run does

1. **Discover** — parse `site/src/lib/affiliate.ts` for products and ASINs, and
   union `/go/` ids from `_redirects`, `src/pages/go/`, and the registry.
   Nothing is configured per site and nothing is tracked centrally; a product
   added later is picked up on the next run.
2. **Check ASINs** (zero tokens) — `getItems` on every ASIN. An ASIN missing
   from the response is a *suspicion*, never a verdict: it is independently
   re-checked with a direct fetch of `/dp/<asin>`, and must be seen dead on two
   consecutive runs before anything happens.
3. **Check cloaks** (zero tokens) — fetch `/go/<id>/` on the live site *without
   following the redirect* and assert the target is Amazon, carries the right
   affiliate tag, and points at the registry's ASIN. Never touches amazon.com,
   so there is no anti-bot failure class at all.
4. **Heal** (the only token spend) — only for a `CONFIRMED_DEAD` ASIN. See below.
5. **Report** — one Slack line, every run, clean or not.

## The heal path

Deterministic code does everything except the one judgment call:

| Step | Who |
|---|---|
| Find candidates (`searchItems`, CloakBrowser fallback) | code |
| Confirm each candidate is real and in stock | code |
| **Pick which candidate fits the brand, write the copy** | **model** |
| Re-verify the chosen ASIN immediately before writing | code |
| Edit `affiliate.ts`, sync `_redirects`, fetch the image | code |
| Run the real `npm run build` as a gate | code |
| Commit, push, queue the deploy | code |

The model returns an **index into a list the API already verified**, never an
ASIN of its own — a hallucinated ASIN cannot reach the registry. Everything it
returns is validated against the candidate set or discarded. If the build gate
fails, `affiliate.ts` and `_redirects` are reverted and nothing ships.

Cap of `MAX_HEALS_PER_RUN = 3`: a run that wants to swap more than three
products is a systemic problem (expired credentials, an API change), not link
rot, and should not rewrite a catalog unattended.

### Rating and review count

`customerReviews.starRating` / `.count` are valid API resources but return
**empty** for this account — worse than a rejection, because it reads as "no
reviews" rather than "not permitted". A heal therefore scrapes them off the
product page via CloakBrowser (`heal.scrape_rating_and_reviews`) so the
replacement ships with real numbers rather than the dead product's. If the
scrape also fails, those fields are flagged in Slack and a `content` task is
filed rather than shipping a fabricated rating on a live page.

## Usage

```sh
# from a site repo root
bash .monorepo-tools/affiliate-sentinel/run-affiliate-sentinel.sh

# report only — no writes, no heal, no deploy, no tokens
bash .monorepo-tools/affiliate-sentinel/run-affiliate-sentinel.sh --dry-run

# check + file tasks, but never auto-replace (zero tokens)
bash .monorepo-tools/affiliate-sentinel/run-affiliate-sentinel.sh --no-heal
```

Direct invocation, e.g. from the host:

```sh
python3 tools/affiliate-sentinel/sentinel.py --site-root sites/<domain> --dry-run --json
```

## Credentials

Read from `<site>/.env.shared` (containers) or the fleet `.env` (host). The
OAuth bearer token is cached at `tools/affiliate-sentinel/.cache/amz-token.json`
(mode 600, gitignored) — deliberately outside every site repo, so no fleet job
that runs `git add -A` can ever sweep a live credential into a commit.

## Manual fallbacks (never scheduled)

Both predecessors are kept for the case where the Amazon API is down or an
account loses eligibility. Neither runs on any cron:

```sh
# curl + soft-404 markers (the old zero-AI sentinel)
python3 tools/affiliate-link-check/check_links.py --repo-root sites/<domain> \
    --base-url https://<domain>

# CloakBrowser landed-page check (heavier, needs a browser)
python3 tools/affiliate-audit/run.py --site <domain>
```

If the API is unavailable, the sentinel degrades rather than failing: it still
runs the cloak check, still reports `Amazon API unavailable` with the number of
ASINs left UNCHECKED, and never heals on missing data.

Where that report lands depends on whether the site has any problem of its own.
An account-wide outage (the standing PA-API 403 "account does not currently
meet the eligibility requirements") is one fact, not one per site, and repeating
it in 26 site channels every night is how a real alert gets tuned out. So when
the outage is the **only** finding, the sentinel logs the line, skips the
per-site post, and exits 4; `run-fleet.sh` then names every affected site, the
total unchecked ASIN count, and the API's own reason in a single `⚠️` message to
`domain-fleet-ops`. The moment a site has a finding of its own — a dead ASIN, a
broken cloak — it is no longer outage-only and posts in its own channel again,
UNCHECKED count included. `--post-api-outage` forces the per-site line back on.

This does not reintroduce the silent-sentinel failure mode: the fleet digest
fires every night the outage lasts, so a quiet ops channel still means the
sweep itself is dead.

## Cadence

Daily, staggered after `tools/amz-stats`' 02:17 collection. Daily beats the old
weekly cadence on confidence as well as speed: the two-consecutive-run
confirmation gate closes in 24 hours instead of two weeks.

## Slack

One line per run, always:

- `✅` all clear
- `⚠️` broken cloak, out of stock, or the API was unavailable alongside another finding
  (an API outage on its own goes to `domain-fleet-ops` once for the whole fleet)
- `🚨` a dead product that could not be auto-replaced — needs a human
- `🔧` a dead product was auto-replaced and deployed

## Relationship to amz-stats

`tools/amz-stats` remains the fleet-wide daily snapshot and history. The
sentinel calls the API itself rather than reading `latest.json`, so it is
per-site, self-contained, and fresh, and works on sites amz-stats has not
picked up yet. It reuses amz-stats' `AMZClient`, item parsing, and — crucially
— `taskfiler.http_confirms_dead`, so there is exactly one definition of "dead"
in the fleet.

`amz-stats`' own auto-taskfiler now stands down on sentinel-managed sites
(`taskfiler.sentinel_owns_site`), which it detects from the
`ops/state/affiliate-sentinel.json` this tool writes every run — no central
enable-list to drift out of sync with the host crontab. If that file goes more
than 7 days stale the sentinel is evidently not running there, and amz-stats
resumes filing so a site never ends up with nobody watching it.

## Tests

```sh
python3 tools/affiliate-sentinel/tests/test_sentinel.py     # unit, no network
tools/affiliate-sentinel/tests/integration_heal.sh          # heal, live API + real build
```

`integration_heal.sh` clones a site to a throwaway dir with no git remote,
injects a confirmed-dead ASIN, and asserts the whole heal: replacement chosen,
registry and `_redirects` updated, build gate passed, deploy queued, commit made.
It costs one Sonnet turn and is not scheduled — run it after touching `heal.py`,
`registry.py`, or `amz.py`. The heal never runs on a healthy fleet, so it is
exactly the code that rots unnoticed.

Covers the registry editor's surgical guarantees, model-output validation
(including hallucinated ASINs and `"choice": true`), the build-gate revert, the
`_redirects` rewrite's precision against sibling ids, cloak classification
(including the deliberately-retired 301 case), and streak state.
