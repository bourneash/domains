# Site-type archetypes

Pick the archetype, copy its reference site as the structural starting point, then rebuild to the
brief. Reference sites live under `/home/jesse/projects/domains/sites/`.

## affiliate

Product-review authority that earns via Amazon Associates. Hand-picked products, real ASINs, honest
editorial voice, FTC-disclosed affiliate links.

- **Copy:** `reviewtattoo.com` (most polished ops/), or a tone-matched sibling (`ultrarough.com`,
  `xxxtea.com`).
- **Needs:** affiliate registry + `/go/` cloaking + disclosures (`references/affiliate-system.md`);
  product images (Phase 4); schema.org with Amazon named as seller.
- **Does NOT need:** news aggregation, heavy persona system (a single editorial voice is fine).

## news-ad

Aggregated-news + editorial brand riding a topical wave, earning via ads/affiliates. Dated editions,
frequent refresh, autonomous publishing.

- **Copy:** `americastrikes.com` (autonomous news ops, CI, image optimization) or `aliencouncil.com`
  (editorial editions + live trackers).
- **Needs:** news aggregation + dated editions (`references/news-aggregation.md`); autonomous cron
  ops (Phase 6); a `<site>.com-update` editorial-cycle skill.
- **Read `americastrikes.com/TODO.md` and its CLAUDE.md first** — that's the live blueprint for the
  aggregation + publishing loop.

## persona-driven

Named writers with distinct voices, cultures, and profile pages drive the content. The personalities
*are* the product.

- **Copy:** `broadwayshowgirls.com` (3 writers, profiles, bylines, co-authored pieces) or
  `sinderella.org` (voice-driven brand, uses a local LLM for persona voice).
- **Needs:** persona system (`references/persona-system.md`); optional local-LLM voice generation
  (sinderella pattern); diverse, well-drawn characters.
- **Voice rule from the fleet:** give each persona a real point of view and culture; don't flatten
  them into one tone. Where a brand has a restraint/irony rule (ultrarough, xxxtea: "restraint is the
  joke"), honor it.

## hybrid

Two or more archetypes composed. This is the common case for an interesting site.

- **Canonical example:** `broadwayshowgirls.com` — persona writers (persona-driven) + each writer's
  hand-picked Amazon products (affiliate) + a news/reviews editorial layer (news-shaped). Read all
  three relevant reference files and compose them.
- Build the persona system first (it's the spine), then attach affiliates per writer, then layer in
  the news/editorial cadence and autonomous ops.

## Choosing a reference when Jesse gives sample sites

If Jesse names sample sites, mirror their *architecture and feel*, not their content. If they're
fleet siblings, read their `site/src/` structure and `CLAUDE.md` directly. If they're external URLs,
study them for layout/voice and map onto the closest fleet archetype's code. If Jesse gives none,
pick the closest sibling from the router table and say which you chose.
