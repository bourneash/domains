# xxxtea Board Report

Latest at top. One section per session.

---

## 2026-05-16 — Scaffold + local LIVE

**Status:** Site built, local smoke 17/17 green. Awaiting Worker creation
in CF dashboard (one-time, ~5 clicks).

### Done

- Astro 5 + Tailwind scaffold under `site/`, mirroring the
  `ultrarough.com` pattern but with its own brand identity (electric
  amber on deep oolong)
- 24 launch SKUs across loose leaf, pyramid bags, paper bags, powders,
  kettles, teapots, infusers, sets
- 75 pages generated: home, /reviews + 24 review pages, /varietals +
  10 varietal pages, /vessels + 5 vessel pages, /brewing, /gallery,
  /about, /contact, /disclosure, /404, /go redirects, rss.xml,
  sitemap-index.xml
- Brand voice + design system locked in `DESIGN_SYSTEM.md`. Palette:
  `steep` (oolong-dark) + `honey` (wet amber) + `porcelain` (cream) +
  reserved `hibiscus` / `jade` accents
- Wordmark: `xxx` honey italic + `tea` porcelain, 60×3 underbar under
  `xxx` only
- 7 source PNGs in `images_for_use/` — converted 4 to webp, 3 missing
  ones aliased to existing slugs (collar-and-chain ← bound-pyramid,
  shibari-steep ← squeezed-silk, slumping-strainer ← suspended-strainer).
  Swap when source images return
- CI: `.github/workflows/security-and-build.yml` — verify-only (audit
  + build)
- Affiliate cloaking via `/go/<id>` from `scripts/build-redirects.mjs`
  → 24 search-URL fallbacks (zero 404 risk; upgrade to `/dp/<asin>` per
  SKU after Playwright verify)

### Blocked on Jesse

See `ops/board/CREDENTIALS_NEEDED.md`.

1. **CF Worker creation** — one-time, ~5 clicks at
   `https://dash.cloudflare.com → Workers & Pages → Create → Worker →
   Connect to Git`. Repo `bourneash/xxxtea.com`, build `npm run build`
   in `site/`, output `site/dist`, Node 20, worker name `xxxtea`
2. **Amazon Associates application** — post-launch, ~10 min form at
   `https://affiliate-program.amazon.com`. Tag `xxxtea-20` already
   hardcoded — clicks attribute the moment approval lands

### Up next (when Worker exists)

- Bind apex + www to worker via API (token has `Workers Domains:Edit`)
- Live smoke 17 routes
- Replace 3 aliased gallery images with real generations (the missing
  source PNGs were removed during scaffold)
- Submit to GSC + Bing Webmaster
- Expand SKU registry to 40 (more matcha, more vessels, sampler
  diversity)
