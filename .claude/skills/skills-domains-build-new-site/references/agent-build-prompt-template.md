# Build prompt: FILL:DOMAIN

Standalone prompt for handing to an AI coding agent to build/continue FILL:DOMAIN. Self-contained
— no prior conversation context required. Paste this whole file as the task.

---

## Task

Build out the domain site **FILL:DOMAIN**, a site in a fleet of ~20 revenue-generating domain
projects managed from `/home/jesse/projects/domains/`. The repo lives at
`/home/jesse/projects/domains/sites/FILL:DOMAIN/` (a git submodule of the domains monorepo, own
GitHub repo `bourneash/FILL:DOMAIN`, private).

Read `/home/jesse/projects/domains/sites/FILL:DOMAIN/CLAUDE.md` first — it is the locked,
owner-approved brand brief. Do not deviate from it or invent new positioning, pillars, or voice.

## What this site is

FILL:SITE_TYPE_SUMMARY (one line — e.g. "Hybrid affiliate gear-guide + single postpartum persona
voice site.")

**Positioning:** FILL:POSITIONING_TAGLINE

FILL:POSITIONING_PARAGRAPH — what it covers, who writes it, what it explicitly is not.

**Audience:** FILL:AUDIENCE

**Revenue thesis:** FILL:REVENUE_THESIS (affiliate tag / ad model / etc.)

**Voice rules (non-negotiable):**
FILL:VOICE_RULES (bulleted)

**Feature toggles:**
- Newsletter/email capture: FILL:ON_OFF
- Affiliates: FILL:ON_OFF — tag `FILL:AFFILIATE_TAG` if applicable
- News/editorial cadence: FILL:ON_OFF
- Persona roster: FILL:PERSONA_ROSTER

**Out of scope (v1):** FILL:OUT_OF_SCOPE

## Fleet stack — do not substitute

- Astro 5 + Tailwind under `site/`. Static output to `site/dist/`.
- Hosting: **Cloudflare Workers + static-assets binding — NOT Pages.** The fleet's CF API token
  has no Pages scope; don't waste cycles probing Pages endpoints.
- Repo: private GitHub `bourneash/FILL:DOMAIN`, SSH alias `git@github-bourneash:`.
- Email Routing: `contact@`, `takedown@`, catch-all → owner inbox. `contact@` is the default
  outward-facing address — never `hello@`.
- CI: `.github/workflows/security-and-build.yml` (npm audit + astro build on push/PR).
- Auto-deploy: CF Workers Builds GitHub integration (one-time dashboard connect, human step).
- Worker name on CF: `FILL:WORKER_NAME` (dots become dashes, e.g. `newmomshop-com`).

**Load-bearing gotchas from past fleet incidents — apply from the start:**
- `astro.config.mjs` must set `prefetch: { prefetchAll: false, defaultStrategy: 'viewport' }`.
  Never `prefetchAll: true` on a site with `/go/` affiliate links — it makes Astro
  viewport-prefetch every same-origin link including `/go/<id>` cloak anchors, each firing a
  phantom affiliate click with no human intent (hit the whole fleet 2026-06-22).
- `@astrojs/cloudflare` 13.6+ writes the real deploy config to `dist/client/wrangler.json`, not
  `dist/server/`. Deploy command must be `wrangler deploy --config dist/client/wrangler.json`.
- If this is an affiliate site: it's an Amazon **affiliate** site, not a storefront — no
  merchant/inventory language; JSON-LD must name Amazon as the seller; affiliate links carry
  `rel="sponsored"`.
- `.env.shared` must be gitignored AND untracked before any `git add -A`.
- Commit per-file (review `git status` output), not a blind `git add -A`.

## Build scope

FILL:BUILD_SCOPE — one subsection per system this site needs, drawn from whichever of these
apply (drop the ones that don't):

**Design.** Rebuild the current brand-neutral Coming Soon scaffold into a real site. Tokens-driven
CSS (CSS custom properties for a palette + per-section accent theming), not raw Tailwind defaults
— match the fleet's recent sites. Tone: FILL:DESIGN_TONE. Pages: FILL:PAGE_LIST.

**Persona(s).** FILL:PERSONA_BUILD_NOTES (profile schema/page, byline component, bio per persona).

**Affiliate system.** `site/src/lib/affiliate.ts` central registry; `/go/<id>` cloaking via
`site/public/_redirects`. Amazon search-URL based (rot-proof) by default, not raw ASINs. Tag:
`FILL:AFFILIATE_TAG`. `rel="sponsored"` on all outbound affiliate links.

**News aggregation.** FILL:NEWS_BUILD_NOTES (only if this site type needs it).

**Initial content.** FILL:INITIAL_CONTENT_PLAN — N pieces covering the brief's pillars, in voice,
each wired to the relevant content systems above.

**Images.** Site should be image-rich. Generate `ops/prompts/<theme>/prompts.txt` files for
Nano-Banana generation if a full art pass isn't feasible in one pass; otherwise use tasteful
placeholder treatment and flag clearly what's placeholder vs final.

**Compliance.** Consent banner, consent-gated GA4 stub (placeholder measurement ID — do not
fabricate a real GA4 ID; GA4 property creation requires the owner's Google login via the
`domains-google-analytics-ga4-admin` skill, which is a separate follow-up step), privacy policy +
cookie policy pages, FTC affiliate disclosure if applicable, `rel="sponsored"` audit.

**Deploy.** `npm run build`, confirm `dist/client/wrangler.json` exists, commit + push per-file,
verify CI. Do not attempt steps requiring the owner's live login (GA4 dashboard, CF Workers Builds
dashboard connect) — flag them as pending instead.

**Ops scaffolding.** `ops/roles/` (planner, content-writer, seo-analyst, engineer, deployer, +
FILL:EXTRA_ROLES), `ops/board/BOARD_REPORT.md`, `ops/tasks/{backlog,in-progress,done}/`. Log the
build to `BOARD_REPORT.md` when done.

**Registration.** Confirm/update `DOMAINS_INDEX.md` and `tools/site-tracker/sites.yml` at the
domains root, then run `tools/scripts/check-index-drift.sh` to confirm no drift.

## Definition of done

Report: what was built, what's placeholder vs final (especially images and the GA4 measurement
ID), what's still pending and needs the owner's manual action (CF Workers Builds dashboard
connect, GA4 login, image generation run), and confirmation the build passes `npm run build` and
is pushed to `origin/main`.
