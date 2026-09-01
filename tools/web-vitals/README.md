# web-vitals — fleet Core Web Vitals + accessibility sweep

Zero AI. Lighthouse against a local headless Chrome, across every `status: live`
site in `registry/fleet.yaml`.

## Why

No Lighthouse or axe run existed anywhere in the fleet. For a portfolio
monetized on organic traffic that is a direct revenue gap: LCP and CLS are
ranking inputs, and an accessibility regression is both a legal exposure and a
plain loss of readers. Neither is noticeable by eye.

First fleet-wide run (2026-09-01, desktop): **8 of 32 sites over budget, 30 with
at least one failing accessibility audit.** `color-contrast` fails on nearly
every site — that is one shared design-token decision, not thirty bugs.

## Lab, not field — and why

This is Lighthouse lab data. Google's CrUX field API reports what real users
actually experienced, which is strictly better *when it exists* — and it does
not exist for most of this fleet, because CrUX only publishes a URL or origin
once it clears a traffic threshold that the majority of these sites are nowhere
near. A check that silently returns "no data" for twenty sites is not a check.

Lab data is available for every site on day one, is comparable run-to-run
because the environment is fixed, and catches a regression the day it ships
instead of 28 days later when the field window catches up. The cost is that lab
numbers are not user numbers: read a score as "did this get worse than it was",
not as "this is what visitors experience".

## Usage

```
python3 tools/web-vitals/vitals-sweep.py                  # table, all live sites
python3 tools/web-vitals/vitals-sweep.py --json
python3 tools/web-vitals/vitals-sweep.py --site xxxtea.com
python3 tools/web-vitals/vitals-sweep.py --mobile         # mobile emulation (default: desktop)
python3 tools/web-vitals/vitals-sweep.py --fail-on-regression
python3 tools/web-vitals/vitals-sweep.py --budget-fail
```

`reports/latest.json` after every run; `reports/history.jsonl` gets one row per
site per run, so a trend is real history rather than a guess.

## Budgets and the noise band

| metric | budget |
|---|---|
| performance | ≥ 0.90 |
| accessibility | ≥ 0.90 |
| LCP | ≤ 2500 ms |
| CLS | ≤ 0.10 |
| TBT | ≤ 200 ms |

These are Google's own "good" thresholds, not aspirations. Separately, a metric
must move by more than a **noise band** (`NOISE` in the script) before it counts
as a regression — Lighthouse is not deterministic, and without the band every
single run reports movement and the signal dies.

A site permanently at 0.72 is a known state; a site that fell from 0.95 to 0.72
last week is news. The sweep reports both, differently.

## Design notes

- **Serial on purpose.** Lighthouse numbers are only comparable when the machine
  is not otherwise busy. Eight parallel headless Chromes would make the sweep
  fast and the data worthless. Full fleet ≈ 20 minutes.
- **Lighthouse is pinned exactly** (`package.json`), same contract as
  `tools/dep-pins`: a floating measuring instrument produces a trend line that
  moves when the tool changes rather than when the sites do.
- **Failing a11y audits are listed by id.** "a11y 0.87" tells you nothing;
  `color-contrast, heading-order` tells you what to fix.
