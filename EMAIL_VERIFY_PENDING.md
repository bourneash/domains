# Email Round-Trip Verification — Pending

Sites where the CF Email Routing **rules are confirmed enabled via API** (contact@,
takedown@, catch-all → jessetamburino@hotmail.com) but the live Resend → CF → hotmail
**round-trip test was not completed** because of sender reputation throttling.

## Why this list exists

On 2026-05-25 we ran ~25 verification emails from `notifications@reviewtattoo.com` in a
short window. Microsoft's spam reputation system flagged the sender and CF Email Routing
started returning `521 5.3.0 Upstream error` for forwards through brand-new zones. The
forwarding setup itself is correct — only the *testing* path is throttled.

This affects only our high-volume verification sender, not real visitors. A real
sender (gmail, proton, etc.) emailing `contact@<DOMAIN>` will use their own sender
reputation and forward through fine.

## How to clear an entry

When reputation resets (typically 24-72h after the throttling event) OR you set up a
fresh verified sender domain in Resend:

```bash
# Per site, serialized — wait for hotmail confirmation before the next one
bash tools/scripts/resend-test-email.sh <DOMAIN>
```

Tick the checkbox + add the date once the round-trip email lands.

## Pending domains

| Domain | Bootstrap date | Verified? |
|---|---|---|
| rodhat.com | 2026-05-26 | ☐ |
| elevatorfriends.com | 2026-05-26 | ☐ |
| broadwayshowgirls.com | 2026-05-26 | ☐ |
| totaljerks.com | 2026-05-26 | ☐ |
| pervypotion.com | 2026-05-26 | ☐ |
