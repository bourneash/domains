# Watchdog fleet stagger map

Every installed watchdog shares the same crontab minute (`2,17,32,47 * * * *`,
`trainingsharks.com` is the one exception at `7,22,37,52`). With 20+ sites on
that line, their probe curls all fired in the same wall-clock second — a burst
of concurrent outbound HTTPS+DNS on one host, occasionally stretching a curl
past its 15s timeout. That tripped `site-down` incidents that self-cleared a
few seconds later — real network contention, not a real outage, but noisy
(2026-08-15 incident: `958faf2f7df1` fired fleet-wide, chronic, days-long).

Fix: `run-watchdog.sh` sleeps a fixed per-site offset before probing, spreading
the fleet evenly across the 15-minute window instead of firing in the same
second. 24 sites, 900s window, 37s step (`900 // 24`).

**Installing a new site:** the original `(last_offset + 37) % 900` rule is
RETIRED — the grid is full (see "Grid is saturated" below). Pick the midpoint
of the widest gap in the table, add the row, and use that value for
`WATCHDOG_STAGGER_SECONDS`. Never reuse an existing offset.

| Site | Offset (s) |
|---|---|
| 0daynews.com | 0 |
| unsupervisedmedia.com | 25 |
| 0xroulette.com | 37 |
| fishhooklabs.com | 40 |
| oventoheaven.com | 62 |
| 3boobs.com | 74 |
| stinkyleftfoot.com | 86 |
| arttogogh.com | 99 |
| aliencouncil.com | 111 |
| eastcoastrappers.com | 130 |
| allthingsmasonic.com | 148 |
| girlpain.com | 167 |
| americastrikes.com | 185 |
| shoppinkflamingo.com | 204 |
| amputeenews.com | 222 |
| broadwayshowgirls.com | 259 |
| deeppenetrations.com | 296 |
| newmomshop.com | 333 |
| rc-9.com | 370 |
| reviewtattoo.com | 407 |
| rodhat.com | 444 |
| saveusfarms.com | 481 |
| shoptopless.com | 518 |
| sinderella.org | 555 |
| totaljerks.com | 592 |
| trainingsharks.com | 629 |
| ultrarough.com | 666 |
| weapontester.com | 703 |
| weirdassstuff.com | 740 |
| weirdgirlstore.com | 777 |
| wetpages.com | 814 |
| xxxtea.com | 851 |
| offshorehookup.com | 888 |

2026-08-28: `unsupervisedmedia.com` and `oventoheaven.com` were assigned raw
sequential offsets (925s, 962s) that overran the 900s cron window itself —
the `sleep` alone took longer than the watchdog's own 15-minute schedule, so
every other scheduled run was skipped (`not starting: job is still running`)
and the one that did run always logged supercronic's `job took too long to
run` warning. Rewrapped both to `offset % 900` (25s, 62s) per this table's
own math; fixed in `ops/scripts/run-watchdog.sh` on both sites.

2026-09-01: `arttogogh.com` was installed with `sleep 25`, a straight
duplicate of `unsupervisedmedia.com` — the one thing this table's rule tells
you not to do. Reassigned to the documented free slot (99s).

2026-09-01 (later): the remaining duplicate pair was cleared —
`fishhooklabs.com` and `stinkyleftfoot.com` had both been installed on an
off-map `sleep 40`. fishhooklabs keeps 40; stinkyleftfoot moved to 86.
`eastcoastrappers.com` had already been moved to 130 separately. The table
above is now regenerated from the live `run-watchdog.sh` files and has no
duplicates.

**Grid is saturated — read this before the next install.** The 37s step was
sized `900 // 24` for 24 sites. There are now 33 watchdogs and every slot on
the original grid (0..888) is allocated, which is why recent installs landed
off-map or duplicated an existing offset. `(last + 37) % 900` no longer
finds free space; it wraps into occupied territory. Before adding another
site, either re-space the fleet on a smaller step (~27s for 33 sites) or move
some sites to a second crontab minute. Until then, pick a free gap from the
table above by inspection and verify with:

    for f in sites/*/ops/scripts/run-watchdog.sh; do \
      grep -m1 '^sleep ' "$f" | awk '{print $2}'; done | sort -n | uniq -d

**Next free slot: 240s** — the midpoint of the largest remaining gap
(222..259). The old `(last + 37) % 900` rule is retired; it assumed a grid
with room left. Pick the widest gap instead:

    # occupied offsets, ascending — read the gaps off this list
    for f in sites/*/ops/scripts/run-watchdog.sh; do \
      grep -m1 '^sleep ' "$f" | awk '{print $2}'; done | sort -n

    # and confirm your pick is not already taken
    for f in sites/*/ops/scripts/run-watchdog.sh; do \
      grep -m1 '^sleep ' "$f" | awk '{print $2}'; done | sort -n | uniq -d

Rolled out 2026-08-15. Sites not yet on the watchdog role (noveltyguns.com,
therareunicorn.com, and others not yet installed) aren't listed — assign them
a slot when they're onboarded.

The 2026-08-25 note here predicted that fishhooklabs.com's hardcoded `sleep
40` would "collide with something later". It did: stinkyleftfoot.com was
stood up on the same hardcoded 40. Closed 2026-09-01 — fishhooklabs keeps 40,
stinkyleftfoot moved to 86. The lesson is that a hardcoded offset is not a
harmless shortcut; every site that skips this table is a future duplicate.

**Map went stale 2026-09-01.** Several installed sites never got a row here —
`unsupervisedmedia.com` (25), `fishhooklabs.com` (40), `stinkyleftfoot.com` (40),
`oventoheaven.com` (62) — so "next free slot on the 37s grid" silently handed out
a duplicate. arttogogh.com was stamped 25, collided with unsupervisedmedia.com,
and its own engineer caught and fixed it the same hour. The 37s grid is now
fully consumed; the four rows below sit in the gaps instead. Before stamping a
new site, derive the used set from the tree, not from this table:

    for f in sites/*/ops/scripts/run-watchdog.sh; do \
      grep -m1 -oP '^sleep \K[0-9]+' "$f"; done | sort -n | uniq

| arttogogh.com | 99 |
| eastcoastrappers.com | 130 |
| girlpain.com | 167 |
| shoppinkflamingo.com | 204 |
