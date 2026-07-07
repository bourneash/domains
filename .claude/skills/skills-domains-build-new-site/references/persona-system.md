# Multi-writer persona system

Reference implementation: **`broadwayshowgirls.com`** (3 writers). All paths below are under
`sites/broadwayshowgirls.com/site/`. Copy its files, then re-cast the personas to the new brief.

## Personas as a content collection

Each writer is one JSON file in `src/content/personas/<slug>.json`, validated by a Zod schema in
`src/content.config.ts`:

```ts
{
  name, role, background,
  orientation: 'straight' | 'bisexual' | 'lesbian',   // diversity is intentional — vary it
  beat: string[],                  // coverage beats
  accentColor: '#RRGGBB',          // drives per-writer CSS theming
  tagline,
  portrait: '/writers/<slug>.jpg', // placeholder OK; Jesse generates real art later
  bioSections: [{ heading, body }, ...],   // min 2
  socials?: [{ label, url }]
}
```

broadwayshowgirls' three: `carmen-delgado.json` (lead critic, burgundy), `priya-raghunathan.json`
(downtown critic, magenta), `imani-carter.json` (webmaster/editor, gold). Give the roster real
cultural and viewpoint diversity per the brief — don't make them interchangeable, and don't make them
all the same orientation. One persona can own the "webmaster/tech" voice if the brief calls for it.

## Profile pages + rendering

- `src/pages/writers/index.astro` — "Meet the [roster]" — one glossy accent-themed card per writer.
- `src/pages/writers/[slug].astro` — full profile: portrait hero in an accent halo, multi-paragraph
  bio, beat chips, social links, the writer's affiliate shelf, and an auto-built archive of their
  articles (resolved from bylines).
- `src/components/Byline.astro` — overlapping avatar stack + linked names + date; used on cards and
  article pages.
- Per-writer theming: each page receives the persona's `accentColor` as a `--accent` CSS var; the
  design system mixes it (`color-mix(in srgb, var(--accent) 40%, transparent)`). Design tokens live
  in `src/styles/tokens.css` + `global.css` — a tokens-only system, **no Tailwind**.

## Articles + the daily random co-authored piece

Articles are Markdown in `src/content/articles/`, schema in `content.config.ts`. Authorship is
single (`byline: <slug>`) XOR co-authored (`bylines: [<slug>, <slug>]`, exactly two). Co-authored
pieces render debate/dialogue-style with both avatars. Other useful frontmatter: `kind`
(review/news/feature/coauthored), `topic`, `rating` (reviews), `image` + `imageCredit`,
`affiliateShelf: <slug>` (whose products show), `keywords`, `pinned`, `unlisted`.

**The daily co-authored article between two random writers** (from the original brief) is an
*autonomous-ops* concern, not a static one. In the reference site it's currently hand-authored
Markdown. To automate it, build it into the content-writer cron role / the `<site>.com-update`
editorial-cycle skill (Phase 6): each run, pick two writers at random, generate a co-authored piece
in their two voices, set `bylines: [a, b]` and `kind: coauthored`, attach one writer's
`affiliateShelf`. Keep the randomness in the script, not hardcoded.

## Local-LLM persona voice (optional — sinderella pattern)

broadwayshowgirls' personas are hand-authored text (no LLM). If the brief wants voices generated at
scale, follow **`sinderella.org`** instead: it drives a local LLM for its voice-driven brand. Read
sinderella's repo + its memory note (`project_sinderella.md`) for the local-LLM wiring (model,
prompt-per-persona, where generation runs) and adapt it. Drive persona voice from a per-persona system
prompt derived from the persona JSON so the data stays the single source of truth.

## Per-writer affiliates

Each writer hand-picks products; a product carries `pickedBy: <slug>`. The writer's profile and their
articles surface their shelf. Full mechanics in `references/affiliate-system.md`.
