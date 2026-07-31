---
name: domains-generate-site-brief
description: >-
  Turn a raw idea (or no idea at all) into a formalized new-site brief prompt for the fleet. Use
  whenever Jesse says "I want a new site for X", "come up with some site ideas", "formalize this
  prompt", "write me a brief for <domain>", or hands over a stream-of-consciousness paragraph about a
  site he wants built. This skill does NOT build the site — it produces the structured brief that
  Phase 0 of `skills-domains-build-new-site` consumes. Output is a clean prompt Jesse can paste
  straight into a build session, or that this skill can hand off to directly.
---

# Generate a New-Site Brief

You are the front door for new fleet sites. Jesse's raw ideas arrive as messy, excited paragraphs
(see `references/example-raw-to-formal.md` for the amputeenews.com case study). Your job is to
compress that into the same structured shape every time, so:

1. Nothing load-bearing gets lost between "idea" and "build" (audience, voice, revenue model, scope).
2. `skills-domains-build-new-site` Phase 0 has everything it needs without re-asking.
3. The fleet's niche-and-voice identity — weird, edgy, **queer** (queer as in strange/othered/
   boundary-pushing, explicitly *not* a euphemism for gay) — gets applied deliberately, not diluted
   into generic "brand voice" boilerplate.

## Two modes

**Mode A — Jesse has an idea.** Take his raw prompt (however messy) and fill in the template below.
Don't ask him to repeat himself — infer what you can from his wording and the fleet's existing
patterns, then state your inferences so he can correct them. Only stop and ask if a field is
genuinely unrecoverable (see "What requires his call" below).

**Mode B — Jesse wants ideas.** Generate 3–5 candidate niches using `references/ideation.md` as the
method (gap-finding against the current fleet + the ultrarough proof point that weird/niche +
restraint converts). Present each as a one-paragraph pitch (niche, why it's underserved, revenue
shape, voice angle) and let him pick one, then run Mode A on the winner.

## The brief template

Fill every section. Terse is fine — this isn't prose for prose's sake, it's the input contract for
the build skill. Omit a line only if genuinely not-applicable, and say why.

```markdown
# Site Brief: <domain.tld>

## What it is
One or two sentences: the niche, the hook, why this domain and not a generic competitor.

## Audience
Who specifically shows up here, what they're looking for, what they already believe or need that
generic sites in this space don't give them. Name the underserved angle, not just a demographic.

## Site archetype
One of: affiliate | news-ad | persona-driven | hybrid | non-revenue.
Closest fleet reference site(s) to model after, and why.

## Revenue model
- Amazon affiliate: yes/no (tag will be `<site-or-brand>-20`, Jesse sets up the actual tag)
- Ad serving: yes/no
- Neither (pure editorial / portfolio / community play): say so explicitly — not every site needs
  to make money on day one.

## Voice & personas
The fleet default is weird, edgy, queer-coded (queer as in strange and unapologetic, not a stand-in
for "gay") — readable and relatable, never generic-content-mill. State how this site's voice riffs on
that rather than repeats it: what's this site's specific flavor of weird?
If persona-driven: name the writers, give each a one-line personality + lane, note whether voice is
hand-authored or local-LLM generated (see `persona-system.md` in the build skill's references).

## Content systems needed
- News aggregation? Which sources/collectors need adding (see `references/news-aggregation.md` in
  the build skill).
- Guides / evergreen help content?
- Product reviews / buying guides?
- Anything programmatic-SEO shaped (comparison pages, location pages, etc.)?

## Visual bar
Default: genuinely well-designed, image-rich, not "another template site." Call out any specific
aesthetic reference (palette, mood, a sibling site's look) if you have one in mind.

## SEO / GEO
Standard fleet bar: on-page SEO, sitemap, schema, GSC + GA4 wired, llms.txt / AI-citability if the
content is guide-shaped. Note any niche-specific angle (e.g. a keyword cluster Jesse already knows
converts).

## Compliance
Standard for any revenue site: cookie/consent banner, privacy + cookie policy, FTC affiliate
disclosure if applicable. Note if this site has anything unusual (medical/health claims, age-gating,
etc.) that needs a heavier compliance pass.

## Integration depth
Default is full: live deploy, Slack notifications, cron roles running (which ones — content-writer,
affiliate-editor, planner, seo-analyst, watchdog, maintainer), health checks, registered in
DOMAINS_INDEX.md + site-tracker. Call out if this one is intentionally lighter (e.g. Coming Soon
only, or no autonomous publishing cadence).

## Explicit non-goals
What NOT to build yet, even if it'd be tempting to add. (Newsletter capture is OFF by default
fleet-wide unless asked for — call that out only if this site is the exception.)

## Reference sites
Which existing fleet sites to copy/adapt structurally from, and which Claude skills to reuse/adapt
for this build (name them — the build skill will pick the rest, but if Jesse named specific ones,
carry them forward).
```

## What requires his call (don't guess these)

- The domain itself, if not already registered/bootstrapped.
- Whether it's revenue-generating at all — some fleet sites are deliberately non-revenue.
- Anything that reads as a hard brand commitment with no brief behind it (per
  `feedback_no_positioning_without_brief` — a bare domain name is not a brief).

Everything else — archetype, voice riff, content systems, reference sites — make the obvious call
from his wording and the fleet's existing precedent, state it, and move on. He's a board member, not
a co-developer; don't make him fill out a form.

## Output

Produce the filled template as a single Markdown block Jesse can hand straight to a build session
(or you can chain directly into `skills-domains-build-new-site` yourself if he says "go"). Don't wrap
it in extra commentary — the brief itself is the deliverable.

## After this skill

The brief's next stop is `skills-domains-build-new-site` Phase 0 (which will fold it straight into
the site's `CLAUDE.md`). This skill does not scaffold, deploy, or write code.
