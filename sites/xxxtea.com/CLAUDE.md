# xxxtea.com

A tea review authority that reads like a fragrance ad campaign.
Reviews loose-leaf, pyramid bags, infusers, kettles, teapots, and the wares
that surround the ritual — by varietal, by vessel, by brew. Reads SFW.
Stares back.

Acquired & scaffolded: 2026-05-16.

## The brand thesis (do not soften)

The domain has three X's. Everyone notices. Nobody says it.

xxxtea is a 100% legitimate buyer's guide for tea and tea wares that *looks*
like a magazine ad for something else. The reader's brain does the rest.

The model is **Liquid Death applied to one of the sleepiest niches on
Amazon — tea and tea accessories**. SFW in copy. Sultry in styling. Both
halves are essential — drop either and the brand collapses.

**Voice rule (non-negotiable)**: kink-coded by *restraint*, never by
declaration. Tea terminology already does most of the work — *steep*,
*brew*, *infuse*, *bind*, *strain*, *tight bag*, *hot water*, *deep*,
*slow*, *long pour*, *full-bodied*, *oversteeped*, *bloom*. Let it land.
Don't underline it. If a line is visibly trying, soften it. See
`DESIGN_SYSTEM.md` for the full voice doc + palette/type lock.

## Stack

- Astro 5 + Tailwind static site under `site/` (same scaffold as
  `ultrarough.com` / `aliencouncil.com` / `americastrikes.com`)
- **Cloudflare Worker + static-assets binding** — NOT Pages. Token has no
  Pages scope. `wrangler.jsonc` + `worker/index.js` + `assets: { directory: "./dist" }`
- Worker name: `xxxtea`. Custom domain bindings: `xxxtea.com` + `www.xxxtea.com`
- CI: `.github/workflows/security-and-build.yml` — verify-only (`npm audit`
  + `astro build`). Deploys handled by CF Workers Builds (Git integration)

## Site structure

- `site/src/lib/affiliate.ts` is the single source of truth — every SKU,
  varietal, vessel, form factor. Page templates derive from it
- Programmatic templates:
  - `/reviews/[id]/` — one page per SKU
  - `/varietals/[slug]/` — one page per leaf type (black, green, oolong,
    white, pu-erh, herbal, matcha)
  - `/vessels/[slug]/` — one page per vessel type (kettle, teapot,
    infuser, matcha set, etc.)
- Cornerstone guide: `/brewing/` (time × temperature by varietal)
- Affiliate cloaking: `/go/<id>` → tagged Amazon URL via
  `site/public/_redirects`. Built from `affiliate.ts` by
  `scripts/build-redirects.mjs`
- Gallery: `/gallery/` — the brand statement. Macro fragrance-ad
  photography of tea, bags, infusers, mesh — single neon accent per
  frame

## Visual identity (locked — see `DESIGN_SYSTEM.md`)

Differentiated from UltraRough on purpose. Where UltraRough is hot pink
on jet black (cold/hot), xxxtea is **electric amber on deep oolong**
(warm/wet).

- Palette: matte oolong-black `steep` family + neon amber `honey` family +
  porcelain cream + crimson `hibiscus` accent + jade for matcha callouts
- Type: Cormorant Garamond (display serif) / Outfit (UI sans) /
  JetBrains Mono (specs)
- Wordmark: `xxx` italic honey-500 + `tea` regular porcelain, with a
  60×3px honey underbar under `xxx` only
- Photography: macro fragrance-ad — silk pyramids under tension, mesh
  infusers, single amber droplets, wet slate, brushed brass. One neon
  accent per frame. No people. No hands. Ever

## Monetization

- Amazon Associates: tracking ID `xxxtea-20` (placeholder until Jesse
  files the application post-launch). Hardcoded into `affiliate.ts` +
  every `/go/<id>` redirect. Application is the post-launch task — Jesse
  files at https://affiliate-program.amazon.com once site is live. Until
  approved the tag is inert; after approval, clicks attribute immediately
  with no code changes
- Display ads: deferred. Mediavine at 50k sessions/mo. AdSense earlier
  if approved. CSP already allows pagead/googlesyndication
- Brand-direct affiliate (Phase 2): Vahdam, Harney & Sons, Fellow,
  Ippodo, FORLIFE — most pay 8-15% vs Amazon's 4%
- Merch (Phase 3): xxx·tea wordmark + bound-pyramid silhouette POD via
  Printify

## Autonomous ops (`ops/`)

Same pattern as sibling projects:
- `ops/roles/` — planner / content / seo-analyst / affiliate / social /
  engineer / deployer
- `ops/board/BOARD_REPORT.md` + `CREDENTIALS_NEEDED.md` — async board
- `ops/tasks/{backlog,in-progress,done}/` — file-based kanban
- `ops/prompts/` — Nano Banana image + video primers (locked aesthetic
  rules — fragrance-ad macro, single neon accent, no people)

## Operating principles

- **The voice is the product.** Restraint *is* the joke. If the
  double-entendre is visibly trying, it breaks the spell
- **The catalog is the SEO weapon.** Every SKU added = 1 review page +
  cross-listings on varietal and vessel pages. Goal: 40 SKUs by month 1,
  100 by month 3
- **No paid sponsorships, ever.** Independence is the brand
- **All edginess lives in styling + social channels. On-page copy stays
  SFW.** Protects AdSense / Mediavine / Amazon eligibility
- **Operate, don't ask.** Jesse is the board member, not the manager

## Quick reference for future agents

1. Read this file
2. Read `DESIGN_SYSTEM.md` (voice + palette — non-negotiable)
3. Read `ops/board/BOARD_REPORT.md` (latest status, top of file)
4. Read `ops/prompts/Primer_images.md` + `Primer_video.md` (locked
   aesthetic rules for image/video gen)
5. SKU registry is `site/src/lib/affiliate.ts` — add SKU + matching
   `/go/<id>` line auto-generates on `npm run build`
6. `git log --oneline -10` for recent activity
