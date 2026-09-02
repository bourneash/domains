# Fleet registry — merge report

`sites/` directories merged: **57** (live 35, scaffold 21, parked 0, redirect 1)

## Coverage per roster

Fleet-wide rosters are expected to list every live site — anything in the
last column is a real gap. Opt-in rosters (subscriptions) are listed for
provenance only; absence there is a choice, not drift.

| Roster | Kind | Covers | Missing live sites |
|---|---|---|---|
| `site-tracker/sites.yml` | fleet-wide | 56/57 | — |
| `data-hub/sites-analytics.yaml` | fleet-wide | 33/57 | arttogogh.com, eastcoastrappers.com, girlpain.com, shoppinkflamingo.com |
| `DOMAINS_INDEX.md` | fleet-wide | 57/57 | — |
| `social registry` | fleet-wide | 48/57 | eastcoastrappers.com, girlpain.com, greatamericanlakes.com, howfishthink.com, offshorehookup.com, shoppinkflamingo.com, unsupervisedmedia.com |
| `data-hub/subscriptions.yaml` | opt-in | 7/57 | n/a |
| `product-feed/subscriptions.yaml` | opt-in | 2/57 | n/a |

## Gaps on live sites

- No `ops/smoke.yaml` (invisible to fleet-gatus): —
- No Slack channel env: greatamericanlakes.com, howfishthink.com
- No worker name in wrangler config: 0xroulette.com, trainingsharks.com

## Stale DOMAINS_INDEX buckets

Sites the index files under a bucket that contradicts disk evidence:

- `broadwayshowgirls.com` — indexed **parked**, actually **live**
- `complicated.work` — indexed **parked**, actually **scaffold**
- `deadlymaracas.com` — indexed **parked**, actually **scaffold**
- `deeppenetrations.com` — indexed **parked**, actually **live**
- `driveford.net` — indexed **parked**, actually **scaffold**
- `drivegm.net` — indexed **parked**, actually **scaffold**
- `dumbsluts.com` — indexed **parked**, actually **scaffold**
- `elevatorfriends.com` — indexed **parked**, actually **scaffold**
- `failbunny.com` — indexed **parked**, actually **scaffold**
- `infrainnovator.com` — indexed **parked**, actually **scaffold**
- `mynewgm.com` — indexed **parked**, actually **scaffold**
- `mynewgm.info` — indexed **parked**, actually **scaffold**
- `nsfwpixels.com` — indexed **parked**, actually **scaffold**
- `pervypotion.com` — indexed **parked**, actually **scaffold**
- `pokererotic.com` — indexed **parked**, actually **scaffold**
- `rodhat.com` — indexed **parked**, actually **live**
- `shoptopless.com` — indexed **parked**, actually **live**
- `stinkyleftfoot.com` — indexed **parked**, actually **live**
- `therareunicorn.com` — indexed **parked**, actually **scaffold**
- `totaljerks.com` — indexed **parked**, actually **live**
- `vibratorporn.com` — indexed **parked**, actually **scaffold**
- `wetslit.com` — indexed **parked**, actually **scaffold**
