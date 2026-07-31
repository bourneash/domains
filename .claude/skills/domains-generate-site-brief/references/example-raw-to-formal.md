# Case study: raw prompt → formal brief (amputeenews.com)

Jesse's raw prompt (verbatim, 2026-07):

> I would like for you to design a new site for us! It should already be in our fleet but as a
> Coming Soon. This will be for amputeenews.com. This site will be a news site dedicated to amputee
> related things. Will be an Amazon Affiliate as well (I will get the amazon affiliate tag setup).
> You can look at our other sites as examples.
>
> You will need to add additional news sources and maybe other things to our media collectors and to
> our news collectors.
>
> Site should look visually good, like really really good. Not just another news site, but, a
> fucking awesome place where users can come and get help and information on this niche topic. Site
> should have helpful information and guides.
>
> Create personalities for the news writers like we do with other sites, make them a little 'weird',
> fun, edgy, readable and relatable.
>
> This should be seo optimized, etc. We have Claude skills for adding sites and also many of these
> other tasks, take them, adapt them, and even copy them as codex skills!
>
> Should be modeled functionally after the sites americastrikes, 0daynews for example. This should be
> a fully functional integration all the way to sending the slack notifications, roles running,
> health checks, etc. It should have privacy policies, acceptance banners, added to GSC and GA4.

What this actually contains, mapped to the template:

- **What it is** — amputee-focused news + help/guides site.
- **Audience** — amputees and their circle (caregivers, family) looking for both news relevant to the
  community and practical help content — an underserved intersection: news sites don't do guides,
  medical/adaptive-gear sites don't do news/community voice.
- **Archetype** — hybrid (news-ad + affiliate + guide content).
- **Revenue** — Amazon affiliate (adaptive gear, mobility products), ad-serving-shaped like other news
  sites.
- **Voice** — weird/fun/edgy/readable/relatable writer personas — explicitly not clinical, not
  pity-toned. This is the part raw prompts under-specify most; push for specifics (names, angles) in
  the formal brief rather than carrying "weird" forward unresolved.
- **Content systems** — news aggregation (new sources needed — amputee/adaptive/disability-specific
  outlets, not just the general news collector), evergreen guides, persona system.
- **Reference sites** — americastrikes, 0daynews (news mechanics); the guide/help layer has no direct
  fleet precedent yet — call that out rather than silently improvising it.
- **Integration depth** — full: Slack, cron roles, health checks, GSC, GA4, consent banner, privacy
  policy — same bar as any live revenue site, starting from Coming Soon.
- **Non-goals** — none stated; default fleet non-goals apply (no newsletter unless asked).

What the raw prompt left *implicit* that the formal brief should make *explicit*: the specific voice
angle (what flavor of weird, beyond "not another news site"), and whether the guide content is
SEO/programmatic-shaped or hand-written editorial. Don't let those stay vague — either state a
concrete answer or flag them as the one open question for Jesse.
