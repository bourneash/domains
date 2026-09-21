# Fleet web-vitals sweep

`vitals-sweep.py` runs pinned Lighthouse + Chromium against every live domain
in `registry/fleet.yaml`. It records performance, LCP, CLS, TBT, accessibility,
absolute budget breaches, and regressions against the previous run.

The fleet scheduler runs mobile daily and desktop weekly. Reports are kept
separate so a desktop run cannot replace the mobile baseline:

- `reports/latest-mobile.json`
- `reports/latest-desktop.json`
- `reports/latest.json` (mobile compatibility alias)
- `reports/history.jsonl` (trend source)

The Fleet Manager SEO Intelligence page reads these artifacts, shows freshness
and per-site trend evidence, and can queue a non-blocking run-now request. The
cron wrapper serializes runs, rotates logs, and notifies only on issue
transitions; healthy recurring runs are silent. Accessibility findings remain
visible in the dashboard and report, but do not create a first-run Slack storm.

For local verification:

```sh
python3 tools/web-vitals/vitals-sweep.py --site example.com --json --no-write
```

The measurement is lab evidence, not a replacement for field data. Use it to
catch changes and prioritize investigation, then confirm important fixes with
real-user metrics when available.
