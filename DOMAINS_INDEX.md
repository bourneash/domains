# Domains Index

## Active sites (built / operating)

| Domain 				| In use | TLDR                                                                                                                      	|
|-----------------------|--------|------------------------------------------------------------------------------------------------------------------------------|
| 3boobs.com 			|   ✅   | Adult novelty / affiliate — CF Workers Builds wired, KV session, auto-deploy verified 2026-06-07 								|
| aliencouncil.com 		|   ✅   | "The Council" — credible UAP/disclosure editorial brand riding the 2026 disclosure wave (ads + affiliate + member tier) 		|
| americastrikes.com 	|   ✅   | Autonomous geopolitics/defense news brand; speed-to-publish play on the Iran cycle, growing into permanent geopolitics brief |
| oventoheaven.com 		|   ✅   | Scaffolded, live on CF Workers Builds — brief/positioning TBD 																|
| rc-9.com 				|   ✅   | "Remote Command" browser artillery game; monetized via HTML5 game portals + rewarded ads + AI battle stream 					|
| reviewtattoo.com 		|   ✅   | Tattoo review & discovery site (cities/styles/guides); affiliate + future paid artist listings 								|
| sinderella.org 		|   ✅   | Daily horoscope/tarot site fronted by "Sinderella," a Jersey Shore boardwalk fortune teller persona 							|
| ultrarough.com 		|   ✅   | Kink-coded sandpaper/abrasives review authority — Liquid Death aesthetic on a boring Amazon niche 							|
| weapontester.com 		|   ✅   | Browser weapon builder + physics-realistic ballistics range; in-tool affiliate links on real parts 							|
| xxxtea.com 			|   ✅   | Fragrance-ad tea + tea-ware review site — "restraint is the joke" voice, honey/amber on oolong-dark, affiliate 				|



## Coming Soon (scaffolded, awaiting brief or CF Worker connection)

| Domain 			| In use | Worker name      | Notes                                                              |
|-------------------|--------|------------------|--------------------------------------------------------------------|
| findyourlostpets.com |   🟡   | `findyourlostpets-com` | Affiliate disclosure removed 2026-05; site live but positioning being reset |
| noveltyguns.com 	|   🟡   | `noveltyguns-com`| CF email ✅                                                        |
| saveusfarms.com 	|   🟡   | `saveusfarms-com`| Brief TBD — rolled back to brand-neutral pending Jesse's brief     |
| wetpages.com 		|   🟡   | `wetpages-com`   | CF email ✅                                                        |



## Parked / empty (registered, no site yet)

| Domain 				| In use | TLDR                                                   |
|-----------------------|--------|--------------------------------------------------------|
| adultxtube.com 		|   ⬜   | 
| broadwayshowgirls.com |   ⬜   | 
| cock-smoker.com 		|   ⬜   | 
| coffeepredator.com 	|   ⬜   | 
| complicated.work 		|   ⬜   | 
| deadlymaracas.com 	|   ⬜   | 
| deeppenetrations.com 	|   ⬜   | Adult niche OR "deep penetration testing" cybersecurity satire — angle undecided 			|
| driveford.net 		|   ⬜   | 
| drivegm.net 			|   ⬜   | 
| dumbsluts.com 		|   ⬜   | 
| elevatorfriends.com 	|   ⬜   | 
| failbunny.com 		|   ⬜   | 
| infrainnovator.com 	|   ⬜   | 
| kinkxels.com 			|   ⬜   | 
| mynewgm.com 			|   ⬜   | 
| mynewgm.info 			|   ⬜   | 
| nsfwpixels.com 		|   ⬜   | 
| nsfwpixles.com 		|   ⬜   | Typo variant of nsfwpixels.com — registered for protection |
| onlysexyteens.com 	|   ⬜   | 
| pervypotion.com 		|   ⬜   | 
| pokererotic.com 		|   ⬜   | 
| rodhat.com 			|   ⬜   | Fishing rod + hat — outdoors/fishing apparel & tackle affiliate (weapontester sibling) 		|
| securityplaces.com 	|   ⬜   | 
| sexchallengecoins.com |   ⬜   | 
| sexchallenge.me 		|   ⬜   | 
| sexvendor.com 		|   ⬜   | 
| shoptopless.com 		|   ⬜   | Satire Jeep 'topless' accessories affiliate amazon store |
| stinkyleftfoot.com 	|   ⬜   | 
| totaljerks.com 		|   ⬜   |
| vibratorporn.com 		|   ⬜   | Adult-toy review authority — ultrarough.com playbook applied to vibrators 					|
| wetslit.com 			|   ⬜   | Adult niche — angle TBD 																		|

_Last updated: 2026-06-07_

## Bootstrap scripts

```bash
# New domain → running site:
tools/scripts/bootstrap-domain.sh <domain>     # scaffold + GitHub + CF email
# (Jesse connects CF Worker via dashboard)
tools/scripts/bind-worker-domain.sh <domain>   # bind custom domain to worker
tools/scripts/setup-cf-email.sh <domain>       # re-run email routing only

# Drift checks (run after any new site goes live):
bash tools/scripts/check-worker-names.sh       # local wrangler name vs CF deployed name
bash tools/scripts/check-index-drift.sh        # sites/ vs DOMAINS_INDEX.md vs sites.yml
```
