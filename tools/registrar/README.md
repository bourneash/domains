# registrar — domain renewal facts from Cloudflare Registrar

Zero AI. One authenticated API call, cached to disk.

## Why

Renewals are the portfolio's largest recurring hard cost, and until 2026-09-01
nothing in the project knew when a single one fell due. The parked-inventory
panel's "Renewal" column read `unknown` for all 23 scaffolds because there was
nowhere to read it from — `registrar_expires` in `registry/fleet.yaml` is
hand-owned and nobody hand-owns it.

## Usage

```
python3 tools/registrar/collect_registrar.py            # refresh cache + table
python3 tools/registrar/collect_registrar.py --json
python3 tools/registrar/collect_registrar.py --days 90  # due inside 90 days
python3 tools/registrar/collect_registrar.py --check    # exit 1 if action needed
```

Writes `cache/latest.json`. The Fleet Dashboard (`/api/registrar` and the
parked-inventory panel) reads that file and **never** calls Cloudflare itself —
a tab must not fail to render because a third-party API is down.

Scheduled at **05:40 daily** inside the fleet-cron container
(`tools/scripts/registrar-cron.sh`, job 20). Unlike the backup and tool-test
jobs it needs only python3 stdlib, the repo mount and outbound HTTPS, so it does
not have to run from the host crontab.

## auto_renew is the signal, not the date

An expiry 40 days out is routine when the domain renews itself and an emergency
when it doesn't. The cron alerts **only** on `auto-renew OFF and renewal inside
90 days`, plus outright collection failure. Everything else is silent — a date
that takes care of itself is not news, and alerting on it daily is how a channel
gets muted.

## Two API quirks worth knowing

**Paging is erratic.** The registrar endpoint returns 0 rows for `per_page=100`,
a short and non-alphabetical 16 for `per_page=50`, and answers honestly only at
`per_page=10`. One page past the end it returns **HTTP 400**, not an empty
result. The collector pages at 10, dedupes by name, and treats a 400 as "done".

**The count it reports is not the count it gives you.** Cloudflare says
`total_count: 66` while only ever yielding 56 distinct domains; the other 10 are
in some state the list endpoint omits. Both numbers are carried into the report
(`claimed_by_cloudflare`, `retrieved`, `unretrievable`) and surfaced in the
table footer. This is deliberate: the first version of this collector silently
reported **16 of 66** as though it were the whole picture, and a renewal you
cannot see is exactly the one that bites.

Domains in the fleet registry that Cloudflare does not hold are listed
separately rather than assumed fine — they may be registered elsewhere.
