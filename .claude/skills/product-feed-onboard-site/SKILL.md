---
name: product-feed-onboard-site
description: >-
  Wire a site's OWN sourcing/publishing pipeline to tools/product-feed —
  the fleet's shared, tagged product-candidate queue. Use when a site wants
  to (a) push candidates it sources+judges itself into the shared feed so
  other sites' matching tags could someday draw from them, and/or (b) pull
  candidates tagged for it (its own, or another site's if tags overlap and
  it's allowed) and publish them on a metered cadence. Covers picking a tag
  taxonomy, the exclusive-vs-shared decision in registry/subscriptions.yaml,
  docker-compose network wiring, and adapting weirdgirlstore.com's producer
  (queue_add.py) / consumer (queue_pull.py) scripts as the reference
  implementation. Do NOT use this to develop product-feed itself — that's
  product-feed-dev.
---

# Onboarding a site to product-feed

Read `tools/product-feed/README.md` first for the API/data-model reference.
This skill is the step-by-step for the site side — the "how do I wire *my*
site to it" walkthrough, not the hub's own internals.

## Before you touch anything: is this site producing, consuming, or both?

- **Producing only** — the site already sources+judges its own candidates
  (its own scout + brand-fit/copywriting agent) and just wants somewhere to
  file accepted ones other than a local disk queue. It doesn't need to pull
  from the feed itself.
- **Consuming only** — rare; means another site (or several) produces
  candidates this site's tags happen to match, and this site just wants to
  publish a steady drip of them. Only makes sense if there's already a
  producer whose tags genuinely overlap this site's niche.
- **Both** — the weirdgirlstore.com pattern: sources+judges its own stuff,
  files it into the feed, and is *also* the only consumer of its own tags
  (`site_origin_allow` scoped to itself). This is the safe default for a
  new site — you get the queue/metering mechanics without actually sharing
  anything yet.

**Default to "both, exclusive" for a first onboarding.** Opening tag-sharing
between two real sites is a deliberate decision (see below), not something
to do by default just because the tags happen to overlap.

## Step 1 — pick a tag taxonomy

Tags are how the hub routes candidates. Reuse the producing site's own
existing category taxonomy if it has one (weirdgirlstore.com tags with its
5 catalog categories: `occult`, `novelty`, `decor`, `wearable`,
`collectibles`) — don't invent a second, hub-specific one. If two sites'
niches could plausibly overlap (e.g. a Masonic-goods site and a
gothic/occult site both stocking ritual candles), that overlap is exactly
what shared tags are FOR — but only open it up if Jesse actually wants the
sites to compete for the same items. Ask, don't assume.

## Step 2 — add (or edit) the subscription

`tools/product-feed/registry/subscriptions.yaml`:

```yaml
your-site.com:
  tags_any: [tag-one, tag-two, ...]
  site_origin_allow: [your-site.com]   # omit this line to allow ANY producer's matching tags — see below
  max_queue_depth: 12                  # a day's worth at your chosen publish cadence; tune to taste
```

- Keep `site_origin_allow` scoped to the site itself unless Jesse explicitly
  wants sharing. Removing it means candidates from ANY producer whose tags
  match get claimable here — first `next` call wins, no double-serving
  (the hub's `claim_next` is transactional), but "first wins" also means the
  two sites are now racing for the same stock, which changes the product
  story for both. That's a real decision, not a config detail.
- **Restart the hub after editing this file** — `docker compose restart api`
  from `tools/product-feed/`. No hot-reload.

## Step 3 — docker-compose network wiring

The site's worker service needs to join the hub's network to reach it by
container name. In the site's `docker-compose.yml`, on the `worker` service:

```yaml
    environment:
      # ...
      PRODUCTFEED_API: "http://product-feed-api:4761"
    networks: [ops, ..., product_feed]   # add product_feed to whatever's already there

networks:
  # ...
  product_feed:
    external: true
    name: product-feed_default
```

**CRITICAL**: `external: true` networks are resolved at container creation
— if `product-feed_default` doesn't exist yet (`tools/product-feed`'s own
compose hasn't been brought up), the site's worker will fail to start
outright, not degrade gracefully. Run `docker network ls | grep
product-feed` before wiring this in, and if it's missing, bring the hub up
first (`cd tools/product-feed && docker compose up -d --build`) — see
product-feed-dev for that stack's own bring-up details.

## Step 4 — producer script (if this site pushes candidates)

Copy the pattern from `sites/weirdgirlstore.com/ops/scripts/product-scout/queue_add.py`,
not from scratch. The shape that matters:

1. Try `POST {PRODUCTFEED_API}/candidates` with
   `{site_origin, tags, candidate, decision}`.
2. **On ANY failure (unreachable, timeout, non-2xx), fall back to writing
   the candidate to a local disk queue** (whatever this site already used
   before onboarding, or a new `ops/state/product-queue/` dir if it's
   greenfield). This is not optional — it's what keeps a site's publishing
   working even if the hub is down or hasn't been brought up yet. Don't ship
   a hub-only integration.

## Step 5 — consumer script (if this site pulls and publishes)

Copy the pattern from `queue_pull.py` in the same directory. The shape:

1. `GET {PRODUCTFEED_API}/subscriptions/<site>/next`. Unreachable → return a
   distinct exit code your wrapper script (see below) recognizes as
   "fall back to local."
2. Item is `null` → nothing to do, exit 0 cleanly. This is a normal, common
   result — don't alert on it.
3. Item present → materialize `candidate`/`decision` into temp files (the
   site's existing apply/publish script almost certainly expects file
   paths, not in-memory dicts — don't rewrite that script to take a
   different interface just to avoid two file writes).
4. If the candidate's image needs re-fetching (image_path from the
   producing site's local disk may not exist for a *different* consuming
   site), re-download from `candidate['image_source_url']` — see
   `queue_pull.py`'s `ensure_image()` for the exact fallback.
5. Run the existing apply/publish step exactly as before onboarding.
6. Success → `POST /candidates/<id>/published`. Failure → `POST
   /candidates/<id>/release` (puts it back in `queued`, not lost).

Then in the cron-facing wrapper script (weirdgirlstore's
`run-product-publish.sh` is the reference), try the hub consumer first;
on its "unreachable" exit code, fall back to whatever local-queue drain
logic the site had before onboarding.

## Step 6 — verify WITHOUT touching production

This is the single most important rule in this skill.
**`apply_candidate.py`-shaped scripts have no dry-run mode — they build,
commit, and PUSH to the site's live repo.** This already happened once
during the initial product-feed build: a fake test candidate landed on
weirdgirlstore.com's `main` branch and had to be `git revert`-ed and
re-pushed immediately.

Verify safely instead:
- Test the hub side with curl or the hub's own pytest suite (see
  product-feed-dev), never through a site's real publish script.
- Test a producer script's hub-POST path with a throwaway candidate, then
  clean the test row out of the hub's SQLite directly
  (`docker exec product-feed-api python3 -c "..."` deleting by ASIN) rather
  than letting a consumer claim and publish it.
- Test a consumer script's "hub unreachable" and "queue empty" paths for
  real (both exit cleanly with no side effects) — these are safe to run
  against the live hub or with `PRODUCTFEED_API` pointed at nothing.
- **Never** run the consumer's full claim → apply → publish chain against
  a real queued item just to see if it works end to end. If you must
  verify that chain, do it against a throwaway git clone of the site's
  repo with `apply_candidate.py`'s git remote pointed somewhere harmless —
  not against the real `origin`.
