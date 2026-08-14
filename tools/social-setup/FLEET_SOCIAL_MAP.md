# Fleet Social Map

Canonical tracker for social media presence across the domain portfolio — both
**brand/business accounts** (one per domain) and **individual writer-persona
accounts** (one per named byline). Source of truth for "what's live, what's
stuck, what's never been attempted." Update this file directly whenever an
account is provisioned, unstuck, or a persona roster changes — don't let the
`skills-domain-social-setup` skill's own status table (§6) drift out of sync;
that skill doc should point here rather than duplicate the table.

Legend: ✅ live · 🟡 stuck/partial · ⛔ blocked · ⬜ not started · — n/a

Last verified against the vault: 2026-08-14 (33 items, live `bw list items` query).

## 1. Brand accounts, by domain

| Domain | Bluesky | Pinterest | Reddit | X | Instagram | TikTok | LinkedIn | Facebook | Notes |
|---|---|---|---|---|---|---|---|---|---|
| americastrikes.com | ✅ | ✅ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Reddit account exists, OAuth app creation silently blocked |
| broadwayshowgirls.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 3-writer roster — see §2 |
| reviewtattoo.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 2 named authors — see §2 |
| rodhat.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Site itself *is* the single persona |
| saveusfarms.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 5-reporter roster — see §2 |
| sinderella.org | ✅ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Pinterest: orphaned email reservation, unresolved |
| ultrarough.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Pre-existing, set up before the vault system |
| 0daynews.com | ✅ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Pinterest stuck · 4-persona roster — see §2 |
| aliencouncil.com | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Bluesky needs a real email verification code (hotmail inbox not auto-readable yet) |
| weirdassstuff.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | No persona roster |
| totaljerks.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Guide queue, no named bylines currently |
| allthingsmasonic.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Handle truncated to `allthingsma.bsky.social` |
| xxxtea.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | — |
| weirdgirlstore.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | No persona roster |
| newmomshop.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Single persona (Dana) — voice only, not a byline roster |
| shoptopless.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Guide queue, no named bylines currently |
| amputeenews.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 3-writer roster — see §2 |
| trainingsharks.com | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | Tool site, no personas |

**Fleet total:** Bluesky 16 live / 1 stuck (17). Pinterest 14 live / 2 stuck /
1 not started (17). Reddit 1 (blocked, parked fleet-wide). X, Instagram,
TikTok, LinkedIn, Facebook: **0 across every domain** — confirmed straight
from the vault item list, not an omission in tracking.

### Not started — active/live sites, no brand social yet
weapontester.com, 0xroulette.com, rc-9.com, fishhooklabs.com, oventoheaven.com

### Positioning TBD — no brief yet, correctly excluded
complicated.work, driveford.net, drivegm.net, findyourlostpets.com,
gate03.com, infrainnovator.com, mynewgm.com, mynewgm.info, noveltyguns.com,
therareunicorn.com, elevatorfriends.com, stinkyleftfoot.com, failbunny.com,
deadlymaracas.com, dumbsluts.com, nsfwpixels.com, nsfwpixles.com,
pervypotion.com, pokererotic.com, wetslit.com

### Explicit / adult-content brands — mainstream platform ToS risk, not attempted
3boobs.com, deeppenetrations.com, vibratorporn.com, wetpages.com

(These two category splits were read from each site's `CLAUDE.md` opening
lines during the 2026-08-14 sweep, not re-verified line by line — sanity
check before treating the list as final.)

## 2. Writer personas — zero individual accounts anywhere

Six sites publish under named bylines. The brand account is live for all six;
**no individual writer has their own Bluesky, Pinterest, or LinkedIn** yet.

| Site | Brand status | Persona | Beat/role | Status |
|---|---|---|---|---|
| americastrikes.com | ✅ live | Sam Reyes | Defense correspondent | ✅ Bluesky (`sam-reyes.bsky.social`) + Pinterest (`samreyes0288`) |
| americastrikes.com | | Lena Park | Markets correspondent | ✅ Bluesky (`lena-park.bsky.social`) + Pinterest (`lenapark0329`) |
| americastrikes.com | | David Mitchell | Diplomacy correspondent | ✅ Bluesky (`david-mitchell38.bsky.social`) + Pinterest (`davidmitchell0109`) |
| americastrikes.com | | Mariam Khalil | Iran & Middle East correspondent | 🟡 Bluesky done (`mariam-khalil.bsky.social`); Pinterest **stuck** — 2 silent submit failures, no error shown, matches the known orphaned-email-reservation pattern |
| americastrikes.com | | Chris Donovan | Washington correspondent | 🟡 Bluesky done (`chris-donovan.bsky.social`); Pinterest **stuck** — same silent-submit-failure pattern as Mariam Khalil |
| saveusfarms.com | ✅ live | Mara Okafor | Reporter | ⬜ no accounts |
| saveusfarms.com | | Desmond Vega | Reporter | ⬜ no accounts |
| saveusfarms.com | | Priya Sundaram | Reporter | ⬜ no accounts |
| saveusfarms.com | | June Whitehorse | Reporter | ⬜ no accounts |
| saveusfarms.com | | Tomas Reyes | Reporter | ⬜ no accounts |
| broadwayshowgirls.com | ✅ live | Priya Raghunathan | Writer | ⬜ no accounts |
| broadwayshowgirls.com | | Imani Carter | Writer | ⬜ no accounts |
| broadwayshowgirls.com | | Carmen Delgado | Writer | ⬜ no accounts |
| amputeenews.com | ✅ live | Moxie Calder | Community & culture | ⬜ no accounts |
| amputeenews.com | | Eli Park | Mobility systems & policy | ⬜ no accounts |
| amputeenews.com | | Mara Riggs | Practical life, work, travel, gear | ⬜ no accounts |
| 0daynews.com | ✅ live (Pinterest stuck) | airgap | Threat intel / breaking | ⬜ no accounts |
| 0daynews.com | | fuse | Practical defense | ⬜ no accounts |
| 0daynews.com | | kilobaud | Analysis | ⬜ no accounts |
| 0daynews.com | | loop | Infrastructure | ⬜ no accounts |
| reviewtattoo.com | ✅ live | Jesse | Founder & editor — real person, not a persona | n/a, his own identity |
| reviewtattoo.com | | Mara | Lead aftercare tester | ⬜ no accounts |

**Scale if pursued for everyone:** 18 personas (excluding Jesse) × up to 3
platforms (Bluesky / Pinterest / LinkedIn) = up to **54 individual accounts**.

**Compliance flag — LinkedIn is not the same risk class as Bluesky/Pinterest.**
LinkedIn requires a real identity behind a profile; a fabricated persona
there is impersonation-adjacent, not just an editorial-voice question.
Americastrikes' own persona rules (`ops/board/personas.md`) already state
this as a hard rule: a byline's bio may describe an editorial assignment,
never a fabricated personal history — "no fake biography on social." Extend
that rule to every persona above. Get explicit per-persona go-ahead before
running any LinkedIn signup; Bluesky/Pinterest carry the same editorial-voice
consideration but not the identity-verification risk.

**Possible rate-limiting flag (2026-08-14):** after 5 persona Pinterest
signups on americastrikes.com in ~20 minutes, the last 2 (Mariam Khalil,
Chris Donovan) failed identically — form fills fine, submit click never
registers, no error banner, no orphaned-email lock either. Matches Pinterest
silently soft-blocking rapid signups from one IP more than the earlier
per-account "Deja vu" reservation bug. Recommend spacing out further
persona signups on the same domain, or pausing entirely for a few hours
before retrying the 2 stuck ones.

## Open decisions

- [ ] Does every persona get a social presence, or only lead/most-active
      bylines per site?
- [ ] LinkedIn: opt-in per persona, or skip entirely for pseudonymous
      bylines?
- [ ] aliencouncil.com Bluesky — needs a real verification code; blocked
      until the email-read service is wired to the hotmail inbox (see
      [[reference_email_client_2fa]]) or Jesse checks it by hand.
- [ ] sinderella.org / 0daynews.com Pinterest — orphaned email reservations,
      no known recovery path yet; revisit or accept as permanently stuck.

Related: `.claude/skills/skills-domain-social-setup/SKILL.md` (operational
playbook — captcha handling, per-platform gotchas, signup scripts).
