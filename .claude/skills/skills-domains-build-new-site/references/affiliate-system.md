# Affiliate system

Domain sites are **Amazon Associates affiliates, not storefronts.** No merchant/inventory language;
JSON-LD names Amazon as seller; affiliate links carry `rel="sponsored"`; every page with links shows
an FTC disclosure. Tracker tag convention: `<brand>-20` (e.g. `broadwayshowgirls-20`).

Two patterns exist in the fleet — pick per site:

## Pattern A — direct tagged links (broadwayshowgirls)

Simplest. Reference: `sites/broadwayshowgirls.com/site/`.

- **Product data:** `src/data/products.ts` (compiled from `ops/affiliate/products.json`). Each item:
  `{ id, asin, title, image, category, pickedBy: <persona-slug>, blurb }`.
- **Helpers:** `src/lib/affiliate.ts`
  ```ts
  export const AFFILIATE_TAG = '<brand>-20';
  export const AFFILIATE_REL = 'sponsored nofollow noopener';
  export const productUrl = (asin) => `https://www.amazon.com/dp/${asin}/?tag=${AFFILIATE_TAG}`;
  export const productsByWriter = (slug) => products.filter(p => p.pickedBy === slug);
  ```
- **UI:** `components/ProductCard.astro` (image + title + blurb + "View on Amazon"),
  `components/ProductShelf.astro` (scroll-snap grid, accent-themed, renders the disclosure),
  `components/AffiliateDisclosure.astro` (inline + block variants, links to `/affiliate-disclosure/`).
- **Per-article shelf:** frontmatter `affiliateShelf: <slug>` → `productsByWriter(slug)` in the
  article layout.

## Pattern B — `/go/` cloaking (reviewtattoo and most affiliate sites)

Cloaks the destination behind a first-party redirect. Reference: `reviewtattoo.com`.

- Central registry in `site/src/lib/affiliate.ts` (id → ASIN/search + metadata).
- `site/public/_redirects` maps `/go/<id>` and `/go/<id>/` → the tagged Amazon URL (often generated
  by a prebuild script from the registry).
- `site/public/robots.txt` disallows `/go/`, `/admin/`, `/api/` so crawlers don't waste budget.
- Links on pages point at `/go/<id>` with `rel="sponsored"`.

Use B when you want clean outbound links, click tracking, and the ability to swap a destination
without re-deploying content. Use A when products are tightly bound to writers/articles and you want
the ASIN visible in the data.

## Sourcing real product data + images

- **Product data:** source/verify real Amazon products via Playwright (`dp` page for ASIN/title,
  search selectors as fallback for volatile inventory). No PA-API. See the fleet note
  `reference_affiliate_product_sourcing.md`. Store raw pulls under `ops/affiliate/raw/<writer>.raw.json`,
  compile the clean list to `ops/affiliate/products.json`.
- **Product images:** Amazon CDN URLs captured via SiteStripe, or generated art via the
  `domains-media-generator-nanobanana` skill, or Pexels (keys in root `.env`). Always carry image
  credit/license where stock is used.
- Each writer "posts their affiliates with their articles" — wire `pickedBy`/`affiliateShelf` so a
  writer's picks appear on their profile and in their bylined pieces. This can be scripted in the
  content-writer cron role.

## Growing catalogs — filters, search, and kits (Pattern B sites)

When a Pattern-B site's whole premise is a deep, growing product catalog (not a handful of picks
scattered through articles), the `/go/` registry above isn't enough on its own — ship these from
the first build pass rather than retrofitting after launch (offshorehookup.com needed this
retrofitted 2026-08-21 after Jesse flagged the static list as inadequate for where the catalog was
headed):

- **Taxonomy on the collection**: extend the product entries with `category`, `tags` (species/
  technique/use-case — whatever the site's cross-linking needs), and a `priceTier`. These are what
  the filter UI below reads.
- **Client-side filter + search**: no backend on a static site — render the full product list to a
  JSON payload at build time, filter/search it with plain vanilla JS on the index page (category
  dropdown, tag chips, text search), update the DOM without a full reload. Match whatever vanilla-JS
  pattern the site already uses elsewhere (e.g. the cookie-consent banner) rather than introducing a
  new one.
- **Kits/bundles**: a kit is several individual products presented and sold as one curated set. Add
  a `kits` collection (or a `components: [product-id, ...]` field on the product collection) so a
  kit page renders "what's in this kit" with a real link to each component's own product page. Each
  kit still gets its own hero image and its own short "why we bundled this" writeup in voice — it's
  a first-class page, not a list fragment.
- **Buy buttons everywhere a product appears** — grid card, detail page, kit component row — must
  all point through the *same* `/go/<id>` cloak. Don't invent a second tracking path for kits; if a
  bundle is itself purchasable as one Amazon link/list, give the bundle its own `/go/<kit-id>` entry
  in the same registry.

## Compliance hooks (don't skip)

The `cookie-compliance` skill owns the full audit, but the affiliate build must ship: a real
`/affiliate-disclosure/` page, an inline disclosure on every page with affiliate links,
`rel="sponsored"` on every affiliate `<a>`, and JSON-LD that names Amazon as the seller (never the
site).
