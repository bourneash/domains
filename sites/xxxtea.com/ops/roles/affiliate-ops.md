# Role: Affiliate Ops

Weekly role. Owns `site/src/lib/affiliate.ts`.

## Job

1. Find 3-5 new SKUs worth adding (look at Amazon best-sellers in tea,
   coffee/tea kettles, teapots, infusers, matcha)
2. For each SKU:
   - Pick a stable `id` (kebab-case, brand-first, no version numbers)
   - Write `name`, `blurb` (3-4 sentences, voice-locked), `pitch`
     (one-line teaser), `searchQuery`, `form`, `varietal`, `caffeine`,
     `brewTemp`, `brewTime`, `bestFor`, `priceTier`
   - Leave `asin` empty for the first pass (the build will fall back to
     `/s?k=` search URL — zero 404 risk)
   - Pick an `image` slug from `site/public/gallery/` (or queue a Nano
     Banana generation in `ops/prompts/`)
3. Run `npm run build` from `site/` — confirm new review page + redirect
   are generated
4. After Playwright verifies the ASIN is stable, swap `asin: 'B...'`
   into the SKU entry so the `/go/<id>` redirect upgrades from `/s?k=`
   to `/dp/<asin>`

## Voice rules (from DESIGN_SYSTEM.md)

- Sentence-length copy. Editorial punchy, not blog-post wordy
- Tea terminology does the work — *steep*, *brew*, *infuse*, *bind*,
  *bloom*, *full-bodied*, *long pour*, *deep*, *slow*. Let it land
- Restraint is the joke. If you can read it three times before catching
  the second meaning, that's the right line
- Never vulgar. Never crude. Never explicit. No emoji. No "spicy"
