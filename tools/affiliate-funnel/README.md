# Affiliate funnel baseline

Run after the Amazon interactive pull and after data-hub has collected the same
calendar window:

```sh
python3 tools/affiliate-funnel/snapshot.py --days 30
```

The snapshot keeps first-party GA4/GSC data and Amazon's account-level
Tracking-ID report separate. Cloudflare Worker logs now emit structured
`affiliate_redirect` events for the focused sites; compare those request logs
with GA4 `affiliate_click` events to remove crawler, prefetch, and checker
traffic from the human conversion denominator.
