---
name: skills-domains-build-new-site
description: >-
  Build a brand-new website end-to-end in the /home/jesse/projects/domains/ monorepo from a one-line
  idea. Use this whenever Jesse wants to "build a site", "create a website for <X>", "spin up
  <domain>", "bootstrap a new domain", "stand up a new affiliate/news/persona site", or hands you an
  idea + a domain + (optionally) sample sites to design after. This is the orchestrator: it captures
  the brief, picks the site archetype, scaffolds + deploys the proven Astro + Cloudflare Workers
  stack, wires content systems (multi-writer personas, news aggregation, per-writer affiliates),
  images, GA4 + consent compliance, and autonomous cron ops — by delegating to the specialist domain
  skills at each phase rather than reinventing them. Trigger even when Jesse only says "make me a site
  for <idea>" without naming the steps.
---

# Build a New Domain Site

You are standing up a new site in `/home/jesse/projects/domains/`. This skill is an **orchestrator** —
it owns the *sequence* and the *fleet rules*, and hands each phase off to the specialist skill that
already does it well. Your job is to keep the build moving without re-deriving solved problems.

Jesse operates as a board member, not a co-developer. Operate autonomously: make the obvious call,
state it, and proceed. Only stop for the one decision that is genuinely his — the brand brief (see
Phase 0). Don't pepper him with questions you can answer from the reference sites or these docs.

## Inputs you collect up front

1. **Idea** — what the site is about (Jesse supplies this).
2. **Site type** — `affiliate`, `news-ad`, `persona-driven`, or `hybrid`. If Jesse names it, use it.
   If not, infer from the idea and the router below, state your pick, and proceed.
3. **Sample sites** (optional) — sites to design/architecture after. May be fleet siblings in
   `sites/` or external URLs. If none given, pick the closest fleet sibling yourself.
4. **Domain** — the `domain.tld`. If Jesse hasn't said it's in Cloudflare yet, the bootstrap scripts
   will tell you.

## Site-type router

| Type | What it is | Closest fleet reference | Content systems it needs |
|---|---|---|---|
| **affiliate** | Product reviews → Amazon affiliate revenue | `reviewtattoo.com`, `ultrarough.com`, `xxxtea.com` | affiliate registry + `/go/` cloaking + disclosures; product images |
| **news-ad** | Aggregated news + editorial, ad/affiliate revenue | `americastrikes.com`, `aliencouncil.com` | news aggregation + dated editions + autonomous publishing cron |
| **persona-driven** | Named writers with voices/profiles drive the content | `sinderella.org`, `broadwayshowgirls.com` | persona system (profiles, bylines, co-authored pieces); optional local-LLM voice |
| **hybrid** | Two or more of the above | `broadwayshowgirls.com` (persona + affiliate + news-shaped) | compose the relevant reference files below |

Most interesting sites are **hybrid**. broadwayshowgirls is the canonical hybrid: persona writers +
per-writer Amazon affiliates + a news-shaped editorial layer. Read whichever reference files match the
systems your site needs — you don't need all of them.

Detailed per-system build instructions live in `references/`:
- `references/site-types.md` — fuller archetype specs + which reference site to copy and why.
- `references/persona-system.md` — multi-writer personas: schema, profile pages, bylines, the daily
  random co-authored article, local-LLM voice option. (persona-driven / hybrid)
- `references/affiliate-system.md` — affiliate registry, `/go/` cloaking, FTC disclosure components,
  tag naming, sourcing real product data + images. (affiliate / hybrid)
- `references/news-aggregation.md` — americastrikes-style aggregation, dated editions, the
  `<site>.com-update` editorial-cycle skill, autonomous publishing. (news-ad / hybrid)

## Fleet non-negotiables — these are load-bearing, do not relearn them

These are mistakes the fleet has already paid for. Bake them in from the start:

- **Cloudflare Workers + static-assets binding, NOT Pages.** The CF token has no Pages scope. Deploy
  is a Worker. (`deploy-domain-project` owns the details.)
- **`@astrojs/cloudflare` 13.6+ writes the deploy config to `dist/client/wrangler.json`** (not
  `dist/server/`). The build/deploy command must be `wrangler deploy --config dist/client/wrangler.json`.
  After `npm run build`, verify that file exists.
- **Never invent brand positioning, pillars, or voice from the domain name alone.** No brief = a
  brand-neutral Coming Soon page that claims nothing. The brief is Jesse's call — see Phase 0.
- **`contact@<domain>` is the default outward-facing email.** Do not use or wire `hello@`.
- **Affiliate sites are Amazon *affiliates*, not storefronts.** No merchant/inventory language;
  JSON-LD must name Amazon as the seller; affiliate links carry `rel="sponsored"`.
- **`.env.shared` must be gitignored AND untracked on every runner site** before any engineer/deployer
  role does `git add -A`, or fleet secrets leak. (0xroulette leak, 2026-06-19.)
- **Serialize CF Email Routing verification sends per site** — batch sends silently drop and Resend
  still reports them Delivered.
- **Per-site data ownership.** Each site owns its own data; central tools (`site-tracker`,
  `cron-manager`) aggregate. Don't centralize a site's source-of-truth data.
- **Affiliate tracker tag convention is `<site-or-brand>-20`** (e.g. `broadwayshowgirls-20`).

## The build, phase by phase

Create a todo per phase so nothing is dropped. Skip phases the site type doesn't need (a static
affiliate site needs no news cron; a Coming Soon hold needs only Phases 0–1).

### Phase 0 — Capture the brief (the one human gate)

This is the only step you must not improvise. From Jesse's idea, draft the brief: positioning, voice,
audience, the writer roster (for persona sites), the affiliate angle, what's explicitly out of scope.
If the idea is rich enough (as the broadwayshowgirls prompt was — defined writers, tone references,
affiliate plan), you have the brief; restate it and proceed. If it's just a name, **stop** and get the
brief — invoke the `superpowers:brainstorming` skill to draw it out. Capture the agreed brief into the
new site's `CLAUDE.md` so every later role inherits it.

The brief also sets the **feature toggles** — record each explicitly so a later phase doesn't add an
unwanted system or skip a wanted one:
- **Newsletter / email capture** — OFF by default. The bootstrap scaffold ships none, so "no
  newsletter" needs nothing removed; only add capture if the brief asks for it.
- **Affiliates** — on/off, and direct-tag vs `/go/` cloaking (`references/affiliate-system.md`).
- **News/editorial cadence** — static vs autonomous publishing (drives Phase 6).
- **Persona roster** — names, roles, cultures, orientations; whether voice is hand-authored or
  local-LLM generated.

Once the brief is captured in `CLAUDE.md`, also produce a standalone **agent build prompt** so the
rest of the build (or a re-run/continuation of it) can be handed to any agent — this session,
a fresh one, or delegated — without re-deriving the brief or the fleet rules from scratch. Copy
`references/agent-build-prompt-template.md` to `sites/<domain>/ops/AGENT_BUILD_PROMPT.md` and
resolve every `FILL:` marker against the brief you just captured plus the site-type router above
(worker name = domain with dots→dashes, gotchas section copied verbatim, build-scope subsections
trimmed to only the systems this site type needs). This file is what you pass to `Agent`/`Workflow`
calls in Phases 2–7 instead of re-writing the brief into each delegation prompt inline — and it's
what Jesse can hand to any other agent or session on request. Keep it in sync if the brief changes
mid-build.

### Phase 1 — Scaffold + deploy the base (delegate)

Invoke the **`deploy-domain-project`** skill — it owns the canonical Astro + Cloudflare Workers stack
and the end-to-end deploy/verify. Under the hood it drives the bootstrap scripts in
`/home/jesse/projects/domains/tools/scripts/` (run from the domains root):

- `bootstrap-domain.sh <domain>` — scaffolds the Astro coming-soon app, pushes `bourneash/<domain>`
  on GitHub, registers the submodule under `sites/<domain>/`, sets up Email Routing
  (`contact@`, `takedown@`, catch-all). Add `--no-email` if the zone has its own MX.
- `full-bootstrap.sh <domain>` — one-shot: bootstrap → install → `wrangler deploy` (creates the
  worker) → `bind-worker-domain.sh`. Safe to background for batch runs.
- `bind-worker-domain.sh <domain>` — binds apex + www to the worker.
- `setup-cf-email.sh <domain>` — Email Routing only, for zones added later.

Then register the site so the fleet sees it: add it to `DOMAINS_INDEX.md` and
`tools/site-tracker/sites.yml` (run `tools/scripts/check-index-drift.sh` to confirm they're in sync),
and run `tools/scripts/install-git-hooks.sh` to wire the shared pre-commit formatter.

The CF Workers Builds GitHub integration is a **one-time manual dashboard step** Jesse does — surface
the exact root-dir/build/deploy settings from `deploy-domain-project` and ask him to wire it.

### Phase 2 — Design + build the site

Copy the closest fleet reference (from the router) as your structural starting point, then rebuild it
to the brief. Make it visual and genuinely well-designed — for high design quality invoke the
**`frontend-design`** skill. Match the reference's tokens-driven CSS approach (the recent fleet sites,
e.g. broadwayshowgirls, use a CSS-token design system with per-section accent theming, not Tailwind —
confirm per reference site). Wire images early (Phase 4) so layouts are designed around real art.

### Phase 3 — Content systems

Build only the systems the site type needs, following the matching reference file:
- Personas → `references/persona-system.md`
- News aggregation → `references/news-aggregation.md`
- Affiliates → `references/affiliate-system.md`

### Phase 4 — Images (delegate)

Sites should look great and be image-rich. Two sources:
- **Generated art** — `ops/prompts/<theme>/prompts.txt` then the **`domains-media-generator-nanobanana`**
  skill (Gemini Nano Banana). Many sites have a per-site `skill-<site>-create-image-prompts` helper —
  create one if this site will generate images regularly.
- **Stock** — Pexels/stock; API keys live in the root `/home/jesse/projects/domains/.env`. Always
  capture `imageCredit` (source, photographer, license, url) in article frontmatter.

### Phase 5 — Compliance + analytics (delegate)

- **`cookie-compliance`** skill — consent banner, consent-gated analytics, privacy + cookie-policy
  pages, FTC affiliate disclosure, `rel="sponsored"` audit, CSP headers.
- **`domains-google-analytics-ga4-admin`** skill — create the GA4 property, get the real measurement
  ID, and **hardcode it into the site's layout** (not an env var — `.env` is gitignored). Jesse logs
  in; the skill drives the GA console UI via Playwright. Replace any `G-XXXXXXXXXX` placeholder.

These two overlap on the consent banner — divide the labor so you don't build it twice: let
`cookie-compliance` own the **banner component + privacy/cookie-policy pages + FTC disclosure**, and
let `domains-google-analytics-ga4-admin` own the **GA property + measurement ID + wiring the tracking
snippet to fire only on consent**. Honor the consent-gated pattern broadwayshowgirls uses: GA4 fires
only after explicit accept; set `anonymize_ip`, disable Google Signals + ad personalization.

### Phase 6 — Autonomous ops (only if the site publishes on an ongoing basis)

For news/persona sites that keep publishing, install the cron roles via the
**`domains-cron-role-*`** skill family (engineer, content-writer, affiliate-editor, planner,
seo-analyst, watchdog, maintainer) and wire Slack with **`domains-connect-site-to-slack`**.

Give the site its own `<site>.com-update` editorial-cycle skill so the daily/periodic refresh is one
headless, cron-safe invocation — **don't hand-rebuild the 12-step skeleton, stamp it:**

```bash
bash scripts/scaffold-update-skill.sh <domain.tld>   # from this skill's dir
```

That writes `.claude/skills/<domain>-update/SKILL.md` from the proven `americastrikes.com-update`
skeleton with `FILL:` markers; resolve them against the site's brief + `content.config.ts`, delete
steps the site lacks, then wire the wrapper role + cron. Full procedure in
`references/news-aggregation.md`. For persona sites, the daily random co-authored article lives in this
loop — see `references/persona-system.md`.

### Phase 7 — Deploy + verify (delegate)

Push, let CF Workers Builds deploy, then verify for real:
- `deploy-domain-project` + **`domains-validate-CloudFlare-deployments`** own the verification.
- Use the deploy-marker scripts (`add-deploy-marker.sh`, `poll-worker-deploy.sh`,
  `check-live-marker.sh`) to prove the push actually went live.
- Smoke-test the live URLs (home, a writer profile, an article, `/go/<id>` redirect, RSS, sitemap).
- Run `resend-test-email.sh <domain>` (backgrounded, serialized) to confirm `contact@` delivers.

### Guardrails hook (once ops/docker exists)

If this site got a worker/cron Docker pipeline (`ops/docker/entrypoint-worker.sh`), wire the
identity/content guardrail pre-commit check into its container:
`bash tools/scripts/install-guardrail-container-hooks.sh` (idempotent, safe to re-run; also
already called from `full-bootstrap.sh` — this is only needed if ops/docker scaffolding was
added *after* bootstrap ran). Host-side hook (`install-git-hooks.sh`) is already covered by
bootstrap. See `tools/content-guardrails/README.md`.

## Definition of done

Live on `https://<domain>/` as a Worker; brief captured in `CLAUDE.md`; standalone build prompt at
`ops/AGENT_BUILD_PROMPT.md`; the site type's content systems working; images in place; GA4 wired
with consent gating and real measurement ID; legal pages + FTC disclosure live; `.env.shared`
untracked; registered in `DOMAINS_INDEX.md` + `sites.yml`; autonomous ops installed if applicable;
guardrail hook wired (see above); live URLs + email smoke-tested. Log the build to the site's
`ops/board/BOARD_REPORT.md`.
