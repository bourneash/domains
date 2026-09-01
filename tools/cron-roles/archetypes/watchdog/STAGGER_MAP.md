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

**Installing a new site:** take the next free slot below (append to the
bottom, `offset = (last_offset + 37) % 900`), add the row, use that value for
`WATCHDOG_STAGGER_SECONDS`. Never reuse an existing offset.

| Site | Offset (s) |
|---|---|
| 0daynews.com | 0 |
| 0xroulette.com | 37 |
| 3boobs.com | 74 |
| aliencouncil.com | 111 |
| allthingsmasonic.com | 148 |
| americastrikes.com | 185 |
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
| unsupervisedmedia.com | 25 |
| oventoheaven.com | 62 |
| arttogogh.com | 99 |

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

Still off-map and colliding, not yet fixed — each needs its own free slot
(136, 173, 210) and a commit in its own submodule:

| Site | Current offset | Collides with |
|---|---|---|
| eastcoastrappers.com | 25 | unsupervisedmedia.com |
| fishhooklabs.com | 40 | stinkyleftfoot.com |
| stinkyleftfoot.com | 40 | fishhooklabs.com |

**Next free slot: 136s** (`(99 + 37) % 900 = 136` — verify against this table
before reusing it).

Rolled out 2026-08-15. Sites not yet on the watchdog role (fishhooklabs.com,
noveltyguns.com, therareunicorn.com, and others not yet installed) aren't
listed — assign them a slot when they're onboarded. Note: fishhooklabs.com's
`run-watchdog.sh` was stood up 2026-08-25 with a hardcoded `sleep 40` instead
of a table-assigned offset — a process gap, not corrected here (out of scope
for the oventoheaven.com standup); flag if it collides with something later.
| arttogogh.com | 25 |
