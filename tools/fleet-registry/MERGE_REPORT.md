# Fleet registry — merge report

`sites/` directories merged: **62** (live 40, scaffold 21, parked 1, redirect 0)

## Coverage per roster

Fleet-wide rosters are expected to list every live site — anything in the
last column is a real gap. Opt-in rosters (subscriptions) are listed for
provenance only; absence there is a choice, not drift.

| Roster | Kind | Covers | Missing live sites |
|---|---|---|---|
| `site-tracker/sites.yml` | fleet-wide | 59/62 | — |
| `data-hub/sites-analytics.yaml` | fleet-wide | 40/62 | — |
| `DOMAINS_INDEX.md` | fleet-wide | 60/62 | — |
| `social registry` | fleet-wide | 35/62 | 3boobs.com, blackmarketapparel.com, deeppenetrations.com, marineactivity.com, saltwaternews.com |
| `data-hub/subscriptions.yaml` | opt-in | 8/62 | n/a |
| `product-feed/subscriptions.yaml` | opt-in | 2/62 | n/a |

## Gaps on live sites

- No `ops/smoke.yaml` (invisible to fleet-gatus): —
- No Slack channel env: —
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
- `howtofry.com` — **absent** from the index, actually **scaffold**
- `infrainnovator.com` — indexed **parked**, actually **scaffold**
- `magicescorts.com` — **absent** from the index, actually **scaffold**
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
