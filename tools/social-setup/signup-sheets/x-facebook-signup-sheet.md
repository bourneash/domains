# X + Facebook Signup Sheet — Fleet Domains & Personas

Generated 2026-08-31. Copy/paste source for manual signups. **Password column is blank on purpose** — fill it in during signup, then import into Vaultwarden. Do not commit real passwords into this file.

## How to use this
- Go row by row. Do X and Facebook separately — check off in the `Done` column as accounts land.
- **X (Twitter) requires SMS verification.** When you reach an X row, tell Claude "start SMSPool for row N" — it will rent a number, hand you the code as it arrives, and note the number's expiry here. See the SMSPool notes section below **before starting the first X row**.
- Facebook Pages need an admin personal profile. All 30 Pages are administered by the **one new master personal account** (row F0, `Unsupervised Media` — real name TBD, not a persona). Create that account FIRST, then create Pages under it.
- Persona personal profiles on Facebook are a real ToS risk (fake-name detection). Budget for account challenges/kills; don't over-invest per persona.

## SMSPool notes (read before first X signup)
- Numbers are rented per-verification and **expire** (SMSPool numbers are typically short-lived — the rental window closes once used or after the pool's TTL). Once a number expires, X may re-prompt for phone verification on login from a new device/IP, or flag 2FA — **if that happens, re-rent a fresh SMSPool number for that account and re-verify; note it in the row's Notes column.**
- If an account has SMS-based 2FA turned on (X may auto-enable this at signup) and the number later expires, you'll be locked out until you either disable SMS 2FA (swap to an authenticator app / backup codes while the number is still live) or rent a fresh number matching the same country/area code X saw originally.
- **Recommendation:** right after phone verification succeeds, go into account settings and switch 2FA to an authenticator app or turn it off, and downgrade to email-only recovery — do this while the SMSPool number is still active. Otherwise every locked-out X account needs a brand-new SMSPool rental just to log back in.

---
## FACEBOOK
---

### F0 — Master Page-Admin Personal Account (create first)
| Field | Value |
|---|---|
| Full name | Unsupervised Media (use a real-sounding first/last, e.g. **Alex Sutter** — Facebook rejects obvious brand names on personal profiles) |
| Email | `admin@unsupervisedmedia.com` |
| Password | |
| Date of birth | 11/14/1993 |
| Gender | Prefer not to say / Custom |
| Role | Admin for all 30 domain Business Pages below |
| Done | ☐ |

### Business Pages (one per domain, admin = F0 account)
| # | Domain | Page Name | Category | About / Description | Website | Contact Email | Password | Done |
|---|---|---|---|---|---|---|---|---|
| F1 | 0daynews.com | 0dayNews | News & Media Website | THE source for 0day and vulnerability news: CVEs, exploits, breaches, and practical defense. | https://0daynews.com | social@0daynews.com | | ☐ |
| F2 | 0xroulette.com | 0xRoulette | App Page | Hacker-focused roulette strategy backtesting platform. The house always wins — this tool shows exactly how. | https://0xroulette.com | social@0xroulette.com | | ☐ |
| F3 | aliencouncil.com | The Council (AlienCouncil) | Entertainment Website | A fictional, perpetually-running state-media feed intercepted from an alien governing body. Twilight Zone energy, played 100% straight. | https://aliencouncil.com | social@aliencouncil.com | | ☐ |
| F4 | allthingsmasonic.com | All Things Masonic | Shopping & Retail | A Masonic gear catalog with a guide layer: regalia, rings, lodge supplies, plus plain-language guides to Freemasonry, joining, and etiquette. | https://allthingsmasonic.com | social@allthingsmasonic.com | | ☐ |
| F5 | americastrikes.com | America Strikes | News & Media Website | An autonomously operated news brand covering geopolitics, defense, and the current moment in American power. | https://americastrikes.com | social@americastrikes.com | | ☐ |
| F6 | amputeenews.com | Amputee News | News & Media Website | A source-backed, practical news and guide desk for amputees, limb-different people, families, and supporters — mobility, community, culture, and access. | https://amputeenews.com | social@amputeenews.com | | ☐ |
| F7 | broadwayshowgirls.com | Broadway Show Girls | Magazine | A Broadway/Off-Broadway magazine written by three fictional staff critics — reviews, news, and features, Playbill-glam design. | https://broadwayshowgirls.com | social@broadwayshowgirls.com | | ☐ |
| F8 | fishhooklabs.com | Fishhook Labs | Product/Service | A guides-and-reviews fishing tackle site — real gear tested against real conditions. | https://fishhooklabs.com | social@fishhooklabs.com | | ☐ |
| F9 | newmomshop.com | New Mom Shop | Shopping & Retail | An Amazon-affiliate guide and review site for new and expecting moms. | https://newmomshop.com | social@newmomshop.com | | ☐ |
| F10 | offshorehookup.com | Offshore Hookup | Product/Service | An Amazon Associates affiliate site for offshore fishing gear and technique. | https://offshorehookup.com | social@offshorehookup.com | | ☐ |
| F11 | oventoheaven.com | Oven to Heaven | Product/Service | A baking and home-oven affiliate/review site. | https://oventoheaven.com | social@oventoheaven.com | | ☐ |
| F12 | rc-9.com | Remote Command | Video Game | A production-quality browser artillery game — build your shot, call in the strike. | https://rc-9.com | social@rc-9.com | | ☐ |
| F13 | reviewtattoo.com | Review Tattoo | Product/Service | An autonomously operated tattoo review and discovery site — artists, aftercare, and honest reviews. | https://reviewtattoo.com | social@reviewtattoo.com | | ☐ |
| F14 | rodhat.com | RodHat | Blog | Old-school UNIX greybeard persona site: daily tech commentary, real Linux/BSD tips, and war stories. | https://rodhat.com | social@rodhat.com | | ☐ |
| F15 | saveusfarms.com | Save Us Farms | News & Media Website | A cinematic, media-forward news portal fighting for US farms against corporate consolidation and climate pressure. | https://saveusfarms.com | social@saveusfarms.com | | ☐ |
| F16 | shoptopless.com | Shoptopless | Product/Service | An Amazon affiliate site for Jeep Wrangler / Gladiator owners running doors-off and top-stowed. | https://shoptopless.com | social@shoptopless.com | | ☐ |
| F17 | sinderella.org | Sinderella | Entertainment Website | An autonomously-operated daily-horoscope and tarot site fronted by sin(Derella), an AI oracle reading real measured signals into daily predictions. | https://sinderella.org | social@sinderella.org | | ☐ |
| F18 | stinkyleftfoot.com | Stinky Left Foot | Community | A Rocket League club with a public playbook — we tell you how it actually is. | https://stinkyleftfoot.com | social@stinkyleftfoot.com | | ☐ |
| F19 | totaljerks.com | Total Jerks | Product/Service | A jerkbait & fishing-tackle affiliate review site. | https://totaljerks.com | social@totaljerks.com | | ☐ |
| F20 | trainingsharks.com | Training Sharks | App Page | A free browser poker trainer that computes every answer instead of looking it up. | https://trainingsharks.com | social@trainingsharks.com | | ☐ |
| F21 | ultrarough.com | Ultra Rough | Product/Service | A kink-coded sandpaper and abrasives review authority. Restraint is the joke. | https://ultrarough.com | social@ultrarough.com | | ☐ |
| F22 | unsupervisedmedia.com | Unsupervised Media | Company | We design, build, and run our own portfolio of media, commerce, and interactive brands from the ground up. | https://unsupervisedmedia.com | social@unsupervisedmedia.com | | ☐ |
| F23 | weapontester.com | Weapon Tester | Video Game | A browser-based weapon builder and physics-realistic ballistics range. | https://weapontester.com | social@weapontester.com | | ☐ |
| F24 | weirdassstuff.com | Weird Ass Stuff | Shopping & Retail | An Amazon-affiliate product-stream site — a scrolling feed of genuinely weird finds. | https://weirdassstuff.com | social@weirdassstuff.com | | ☐ |
| F25 | weirdgirlstore.com | Weird Girl Store | Shopping & Retail | An Amazon-affiliate review site for genuinely strange home, decor, and gift goods — occult curios, gothic novelty, cryptid ephemera. | https://weirdgirlstore.com | social@weirdgirlstore.com | | ☐ |
| F26 | wetpages.com | Wetpages | Product/Service | A spicy-romance and BookTok-smut review authority — the filthiest shelf on Amazon, reviewed straight-faced. | https://wetpages.com | social@wetpages.com | | ☐ |
| F27 | xxxtea.com | XXXTea | Product/Service | A tea review authority that reads like a fragrance ad campaign. | https://xxxtea.com | social@xxxtea.com | | ☐ |
| F28 | arttogogh.com | Art To Gogh | Shopping & Retail | A late-night art discovery and Amazon affiliate site — Christie's polish through a 2am drive-through window. | https://arttogogh.com | social@arttogogh.com | | ☐ |
| F29 | eastcoastrappers.com | East Coast Rappers | Community | A visual gear, guide, concert, and discovery hub for current and aspiring East Coast rappers. | https://eastcoastrappers.com | social@eastcoastrappers.com | | ☐ |
| F30 | girlpain.com | Girlpain | News & Media Website | A candid, practical editorial site for women who are tired of pretending things don't hurt. | https://girlpain.com | social@girlpain.com | | ☐ |

### Persona Personal Profiles (individual FB accounts)
| # | Domain | Persona | Full Name | Email | Password | DOB | Gender | Bio / About | Done |
|---|---|---|---|---|---|---|---|---|---|
| P1 | 0daynews.com | Morgan Reyes | Morgan Reyes | airgap@0daynews.com | | 07/17/1991 | Custom / Prefer not to say | Threat intel & breaking news desk for 0dayNews — terse, confidence-flagged reporting on active exploitation. | ☐ |
| P2 | 0daynews.com | Marisol Delgado | Marisol Delgado | fuse@0daynews.com | | 09/17/1990 | Female | Practical defense desk for 0dayNews — blunt, no-nonsense patch-and-mitigate guidance. | ☐ |
| P3 | 0daynews.com | Dave Ferris | Dave Ferris | kilobaud@0daynews.com | | 05/23/1979 | Male | Analysis desk for 0dayNews — measured, deep-dive breakdowns of vulnerability research. | ☐ |
| P4 | 0daynews.com | Nadia Park | Nadia Park | loop@0daynews.com | | 06/07/2001 | Female | Infrastructure desk for 0dayNews — dry, meticulous coverage of the systems underneath the breach. | ☐ |
| P5 | americastrikes.com | Chris Donovan | Chris Donovan | chris-donovan@americastrikes.com | | 11/20/1988 | Male | Washington correspondent for America Strikes. | ☐ |
| P6 | americastrikes.com | David Mitchell | David Mitchell | david-mitchell@americastrikes.com | | 12/18/1995 | Male | Diplomacy correspondent for America Strikes. | ☐ |
| P7 | americastrikes.com | Lena Park | Lena Park | lena-park@americastrikes.com | | 02/23/1991 | Female | Markets correspondent for America Strikes. | ☐ |
| P8 | americastrikes.com | Mariam Khalil | Mariam Khalil | mariam-khalil@americastrikes.com | | 11/18/2000 | Female | Iran & Middle East correspondent for America Strikes. | ☐ |
| P9 | americastrikes.com | Sam Reyes | Sam Reyes | sam-reyes@americastrikes.com | | 12/16/1985 | Male | Defense correspondent for America Strikes covering Pentagon procurement and US military operations. | ☐ |
| P10 | amputeenews.com | Eli Park | Eli Park | eli-park@amputeenews.com | | 07/12/2001 | Male | Mobility systems, policy & technology desk for Amputee News. | ☐ |
| P11 | amputeenews.com | Mara Riggs | Mara Riggs | mara-riggs@amputeenews.com | | 09/28/2001 | Female | Practical life, work, travel & gear desk for Amputee News. | ☐ |
| P12 | amputeenews.com | Moxie Calder | Moxie Calder | moxie-calder@amputeenews.com | | 05/26/1979 | Female | Community & culture desk for Amputee News. | ☐ |
| P13 | broadwayshowgirls.com | Carmen Delgado | Carmen Delgado | carmen-delgado@broadwayshowgirls.com | | 09/12/1998 | Female | Staff critic at Broadway Show Girls — primary beat: musicals. | ☐ |
| P14 | broadwayshowgirls.com | Imani Carter | Imani Carter | imani-carter@broadwayshowgirls.com | | 09/26/1984 | Female | Staff critic & webmaster at Broadway Show Girls — primary beat: musicals & spectacle. | ☐ |
| P15 | broadwayshowgirls.com | Priya Raghunathan | Priya Raghunathan | priya-raghunathan@broadwayshowgirls.com | | 10/25/1984 | Female | Staff critic at Broadway Show Girls — primary beat: plays & Off-Broadway. | ☐ |
| P16 | saveusfarms.com | Desmond Vega | Desmond Vega | desmond-vega@saveusfarms.com | | 07/01/1980 | Male | Reporter at Save Us Farms. | ☐ |
| P17 | saveusfarms.com | June Whitehorse | June Whitehorse | june-whitehorse@saveusfarms.com | | 07/21/1984 | Female | Reporter at Save Us Farms. | ☐ |
| P18 | saveusfarms.com | Mara Okafor | Mara Okafor | mara-okafor@saveusfarms.com | | 08/19/1981 | Female | Reporter at Save Us Farms. | ☐ |
| P19 | saveusfarms.com | Priya Sundaram | Priya Sundaram | priya-sundaram@saveusfarms.com | | 07/02/1998 | Female | Reporter at Save Us Farms. | ☐ |
| P20 | saveusfarms.com | Tomas Reyes | Tomas Reyes | tomas-reyes@saveusfarms.com | | 02/26/1989 | Male | Reporter at Save Us Farms. | ☐ |
| P21 | reviewtattoo.com | Mara | Mara | mara-aftercare@reviewtattoo.com | | 08/02/1986 | Female | Lead aftercare tester at Review Tattoo. | ☐ |

**Note:** reviewtattoo.com's other listed persona, "Jesse" (Founder & editor), is Jesse's real identity, not a fictional persona — **do not create a fake account for it.** Use Jesse's own Facebook if a founder-facing profile is ever wanted.

---
## X (TWITTER)
---

### Brand Accounts (one per domain)
| # | Domain | Name | Suggested @handle | Email | Password | DOB | Bio (≤160 char) | Website | SMSPool # | 2FA switched to authenticator? | Done |
|---|---|---|---|---|---|---|---|---|---|---|---|
| X1 | 0daynews.com | 0dayNews | @0daynews | social@0daynews.com | | 12/24/1995 | THE source for 0day and vulnerability news: CVEs, exploits, breaches, and practical defense. | https://0daynews.com | | ☐ | ☐ |
| X2 | 0xroulette.com | 0xRoulette | @0xroulette | social@0xroulette.com | | 07/12/1980 | Hacker-focused roulette strategy backtesting platform. The house always wins — this tool shows exactly how. | https://0xroulette.com | | ☐ | ☐ |
| X3 | aliencouncil.com | The Council (AlienCouncil) | @aliencouncil | social@aliencouncil.com | | 05/04/1992 | A fictional, perpetually-running state-media feed intercepted from an alien governing body. Twilight Zone energy, played 100% straight. | https://aliencouncil.com | | ☐ | ☐ |
| X4 | allthingsmasonic.com | All Things Masonic | @allthingsmasonic | social@allthingsmasonic.com | | 07/19/1980 | A Masonic gear catalog with a guide layer: regalia, rings, lodge supplies, plus plain-language guides to Freemasonry, joining, and etiquette. | https://allthingsmasonic.com | | ☐ | ☐ |
| X5 | americastrikes.com | America Strikes | @americastrikes | social@americastrikes.com | | 01/10/1993 | An autonomously operated news brand covering geopolitics, defense, and the current moment in American power. | https://americastrikes.com | | ☐ | ☐ |
| X6 | amputeenews.com | Amputee News | @amputeenews | social@amputeenews.com | | 10/25/2000 | A source-backed, practical news and guide desk for amputees, limb-different people, families, and supporters — mobility, community, culture, and access. | https://amputeenews.com | | ☐ | ☐ |
| X7 | broadwayshowgirls.com | Broadway Show Girls | @broadwayshowgirls | social@broadwayshowgirls.com | | 06/19/1981 | A Broadway/Off-Broadway magazine written by three fictional staff critics — reviews, news, and features, Playbill-glam design. | https://broadwayshowgirls.com | | ☐ | ☐ |
| X8 | fishhooklabs.com | Fishhook Labs | @fishhooklabs | social@fishhooklabs.com | | 07/04/1986 | A guides-and-reviews fishing tackle site — real gear tested against real conditions. | https://fishhooklabs.com | | ☐ | ☐ |
| X9 | newmomshop.com | New Mom Shop | @newmomshop | social@newmomshop.com | | 12/28/1979 | An Amazon-affiliate guide and review site for new and expecting moms. | https://newmomshop.com | | ☐ | ☐ |
| X10 | offshorehookup.com | Offshore Hookup | @offshorehookup | social@offshorehookup.com | | 04/20/1991 | An Amazon Associates affiliate site for offshore fishing gear and technique. | https://offshorehookup.com | | ☐ | ☐ |
| X11 | oventoheaven.com | Oven to Heaven | @oventoheaven | social@oventoheaven.com | | 07/20/1998 | A baking and home-oven affiliate/review site. | https://oventoheaven.com | | ☐ | ☐ |
| X12 | rc-9.com | Remote Command | @rc9 | social@rc-9.com | | 03/14/1994 | A production-quality browser artillery game — build your shot, call in the strike. | https://rc-9.com | | ☐ | ☐ |
| X13 | reviewtattoo.com | Review Tattoo | @reviewtattoo | social@reviewtattoo.com | | 07/23/1989 | An autonomously operated tattoo review and discovery site — artists, aftercare, and honest reviews. | https://reviewtattoo.com | | ☐ | ☐ |
| X14 | rodhat.com | RodHat | @rodhat | social@rodhat.com | | 05/20/1993 | Old-school UNIX greybeard persona site: daily tech commentary, real Linux/BSD tips, and war stories. | https://rodhat.com | | ☐ | ☐ |
| X15 | saveusfarms.com | Save Us Farms | @saveusfarms | social@saveusfarms.com | | 09/12/1994 | A cinematic, media-forward news portal fighting for US farms against corporate consolidation and climate pressure. | https://saveusfarms.com | | ☐ | ☐ |
| X16 | shoptopless.com | Shoptopless | @shoptopless | social@shoptopless.com | | 12/03/1988 | An Amazon affiliate site for Jeep Wrangler / Gladiator owners running doors-off and top-stowed. | https://shoptopless.com | | ☐ | ☐ |
| X17 | sinderella.org | Sinderella | @sinderella | social@sinderella.org | | 10/07/1978 | An autonomously-operated daily-horoscope and tarot site fronted by sin(Derella), an AI oracle reading real measured signals into daily predictions. | https://sinderella.org | | ☐ | ☐ |
| X18 | stinkyleftfoot.com | Stinky Left Foot | @stinkyleftfoot | social@stinkyleftfoot.com | | 10/08/1992 | A Rocket League club with a public playbook — we tell you how it actually is. | https://stinkyleftfoot.com | | ☐ | ☐ |
| X19 | totaljerks.com | Total Jerks | @totaljerks | social@totaljerks.com | | 05/21/2001 | A jerkbait & fishing-tackle affiliate review site. | https://totaljerks.com | | ☐ | ☐ |
| X20 | trainingsharks.com | Training Sharks | @trainingsharks | social@trainingsharks.com | | 08/10/1989 | A free browser poker trainer that computes every answer instead of looking it up. | https://trainingsharks.com | | ☐ | ☐ |
| X21 | ultrarough.com | Ultra Rough | @ultrarough | social@ultrarough.com | | 04/04/1978 | A kink-coded sandpaper and abrasives review authority. Restraint is the joke. | https://ultrarough.com | | ☐ | ☐ |
| X22 | unsupervisedmedia.com | Unsupervised Media | @unsupervisedmedia | social@unsupervisedmedia.com | | 05/14/1989 | We design, build, and run our own portfolio of media, commerce, and interactive brands from the ground up. | https://unsupervisedmedia.com | | ☐ | ☐ |
| X23 | weapontester.com | Weapon Tester | @weapontester | social@weapontester.com | | 04/26/1999 | A browser-based weapon builder and physics-realistic ballistics range. | https://weapontester.com | | ☐ | ☐ |
| X24 | weirdassstuff.com | Weird Ass Stuff | @weirdassstuff | social@weirdassstuff.com | | 11/28/1986 | An Amazon-affiliate product-stream site — a scrolling feed of genuinely weird finds. | https://weirdassstuff.com | | ☐ | ☐ |
| X25 | weirdgirlstore.com | Weird Girl Store | @weirdgirlstore | social@weirdgirlstore.com | | 02/20/2000 | An Amazon-affiliate review site for genuinely strange home, decor, and gift goods — occult curios, gothic novelty, cryptid ephemera. | https://weirdgirlstore.com | | ☐ | ☐ |
| X26 | wetpages.com | Wetpages | @wetpages | social@wetpages.com | | 12/22/1990 | A spicy-romance and BookTok-smut review authority — the filthiest shelf on Amazon, reviewed straight-faced. | https://wetpages.com | | ☐ | ☐ |
| X27 | xxxtea.com | XXXTea | @xxxtea | social@xxxtea.com | | 05/12/1979 | A tea review authority that reads like a fragrance ad campaign. | https://xxxtea.com | | ☐ | ☐ |
| X28 | arttogogh.com | Art To Gogh | @arttogogh | social@arttogogh.com | | 07/06/1996 | A late-night art discovery and Amazon affiliate site — Christie's polish through a 2am drive-through window. | https://arttogogh.com | | ☐ | ☐ |
| X29 | eastcoastrappers.com | East Coast Rappers | @eastcoastrappers | social@eastcoastrappers.com | | 09/28/1995 | A visual gear, guide, concert, and discovery hub for current and aspiring East Coast rappers. | https://eastcoastrappers.com | | ☐ | ☐ |
| X30 | girlpain.com | Girlpain | @girlpain | social@girlpain.com | | 03/22/1989 | A candid, practical editorial site for women who are tired of pretending things don't hurt. | https://girlpain.com | | ☐ | ☐ |

### Persona Accounts
| # | Domain | Persona | Suggested @handle | Email | Password | DOB | Bio (≤160 char) | Website | SMSPool # | 2FA switched to authenticator? | Done |
|---|---|---|---|---|---|---|---|---|---|---|---|
| XP1 | 0daynews.com | Morgan Reyes | @airgap | airgap@0daynews.com | | 03/21/1981 | Threat intel & breaking news desk for 0dayNews — terse, confidence-flagged reporting on active exploitation. | https://0daynews.com | | ☐ | ☐ |
| XP2 | 0daynews.com | Marisol Delgado | @fuse | fuse@0daynews.com | | 01/21/1982 | Practical defense desk for 0dayNews — blunt, no-nonsense patch-and-mitigate guidance. | https://0daynews.com | | ☐ | ☐ |
| XP3 | 0daynews.com | Dave Ferris | @kilobaud | kilobaud@0daynews.com | | 05/24/1989 | Analysis desk for 0dayNews — measured, deep-dive breakdowns of vulnerability research. | https://0daynews.com | | ☐ | ☐ |
| XP4 | 0daynews.com | Nadia Park | @loop | loop@0daynews.com | | 03/16/1984 | Infrastructure desk for 0dayNews — dry, meticulous coverage of the systems underneath the breach. | https://0daynews.com | | ☐ | ☐ |
| XP5 | americastrikes.com | Chris Donovan | @chrisdonovan | chris-donovan@americastrikes.com | | 03/23/1985 | Washington correspondent for America Strikes. | https://americastrikes.com | | ☐ | ☐ |
| XP6 | americastrikes.com | David Mitchell | @davidmitchell | david-mitchell@americastrikes.com | | 11/09/1985 | Diplomacy correspondent for America Strikes. | https://americastrikes.com | | ☐ | ☐ |
| XP7 | americastrikes.com | Lena Park | @lenapark | lena-park@americastrikes.com | | 02/21/1980 | Markets correspondent for America Strikes. | https://americastrikes.com | | ☐ | ☐ |
| XP8 | americastrikes.com | Mariam Khalil | @mariamkhalil | mariam-khalil@americastrikes.com | | 07/13/1994 | Iran & Middle East correspondent for America Strikes. | https://americastrikes.com | | ☐ | ☐ |
| XP9 | americastrikes.com | Sam Reyes | @samreyes | sam-reyes@americastrikes.com | | 11/15/1978 | Defense correspondent for America Strikes covering Pentagon procurement and US military operations. | https://americastrikes.com | | ☐ | ☐ |
| XP10 | amputeenews.com | Eli Park | @elipark | eli-park@amputeenews.com | | 02/03/1994 | Mobility systems, policy & technology desk for Amputee News. | https://amputeenews.com | | ☐ | ☐ |
| XP11 | amputeenews.com | Mara Riggs | @marariggs | mara-riggs@amputeenews.com | | 01/01/2000 | Practical life, work, travel & gear desk for Amputee News. | https://amputeenews.com | | ☐ | ☐ |
| XP12 | amputeenews.com | Moxie Calder | @moxiecalder | moxie-calder@amputeenews.com | | 03/15/1995 | Community & culture desk for Amputee News. | https://amputeenews.com | | ☐ | ☐ |
| XP13 | broadwayshowgirls.com | Carmen Delgado | @carmendelgado | carmen-delgado@broadwayshowgirls.com | | 07/17/1990 | Staff critic at Broadway Show Girls — primary beat: musicals. | https://broadwayshowgirls.com | | ☐ | ☐ |
| XP14 | broadwayshowgirls.com | Imani Carter | @imanicarter | imani-carter@broadwayshowgirls.com | | 12/22/1978 | Staff critic & webmaster at Broadway Show Girls — primary beat: musicals & spectacle. | https://broadwayshowgirls.com | | ☐ | ☐ |
| XP15 | broadwayshowgirls.com | Priya Raghunathan | @priyaraghunathan | priya-raghunathan@broadwayshowgirls.com | | 11/06/1996 | Staff critic at Broadway Show Girls — primary beat: plays & Off-Broadway. | https://broadwayshowgirls.com | | ☐ | ☐ |
| XP16 | saveusfarms.com | Desmond Vega | @desmondvega | desmond-vega@saveusfarms.com | | 10/26/1999 | Reporter at Save Us Farms. | https://saveusfarms.com | | ☐ | ☐ |
| XP17 | saveusfarms.com | June Whitehorse | @junewhitehorse | june-whitehorse@saveusfarms.com | | 01/18/1980 | Reporter at Save Us Farms. | https://saveusfarms.com | | ☐ | ☐ |
| XP18 | saveusfarms.com | Mara Okafor | @maraokafor | mara-okafor@saveusfarms.com | | 03/09/1983 | Reporter at Save Us Farms. | https://saveusfarms.com | | ☐ | ☐ |
| XP19 | saveusfarms.com | Priya Sundaram | @priyasundaram | priya-sundaram@saveusfarms.com | | 04/14/2001 | Reporter at Save Us Farms. | https://saveusfarms.com | | ☐ | ☐ |
| XP20 | saveusfarms.com | Tomas Reyes | @tomasreyes | tomas-reyes@saveusfarms.com | | 12/07/1987 | Reporter at Save Us Farms. | https://saveusfarms.com | | ☐ | ☐ |
| XP21 | reviewtattoo.com | Mara | @maratattoo | mara-aftercare@reviewtattoo.com | | 05/09/1978 | Lead aftercare tester at Review Tattoo. | https://reviewtattoo.com | | ☐ | ☐ |

**Note:** reviewtattoo.com's "Jesse" persona is skipped here too (real person — see Facebook note above).

### Known X blockers (context, don't re-litigate blind)
- 0daynews.com brand X: 9 attempts 2026-08-29, all failed at phone-verify submit ("Something went wrong") — reproduced across VPN pop + fresh browser profile. Suspected SMSPool number range flagged by X, or VPN egress fingerprinted as datacenter traffic. **Try a fresh SMSPool number and/or non-VPN egress before retrying this row.**
- reviewtattoo.com brand X: stuck on the same phone-number screen, script-side bug (missing loop deadline) — will need a manual click-through this time, don't trust full automation for this row.
