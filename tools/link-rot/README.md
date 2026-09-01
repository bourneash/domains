# link-rot — fleet-wide broken-link sweep

Zero AI. HTTP plus a regex over `<a href>`, across every `status: live` site in
`registry/fleet.yaml`.

## Why

The fleet checked two narrow slices of its links and nothing else:
`tools/affiliate-link-check` (the `/go/<id>` cloaks) and
`domains-audit-article-images` (`<img>` sources, one site at a time). The
ordinary links — nav, editorial, cross-site, taxonomy — rotted unobserved. The
first fleet-wide run (2026-09-01) found **27 dead internal links across 7 of 30
live sites**, none of which any existing check would ever have reported.

An internal 404 costs twice: crawl budget spent on dead ends and orphaned
pages (SEO), and a reader who clicked something that went nowhere (trust).
Both are machine-detectable for the price of a HEAD request.

## Usage

```
python3 tools/link-rot/link-sweep.py                  # table, all live sites
python3 tools/link-rot/link-sweep.py --json
python3 tools/link-rot/link-sweep.py --site xxxtea.com
python3 tools/link-rot/link-sweep.py --outbound       # also check third parties (slow)
python3 tools/link-rot/link-sweep.py --fail-on-new    # cron/CI gate
python3 tools/link-rot/link-sweep.py --max-pages 50
```

Every run writes `reports/latest.json` and appends `reports/history.jsonl`.
`--fail-on-new` exits 1 only for findings absent from the previous run, so a
known-broken link does not spam a cron forever — the same discipline the lint
sweep uses.

## What it checks, and what it deliberately does not

| kind | checked | why |
|---|---|---|
| `internal` | always | Ours, authoritative, and the highest-value signal. |
| `cross-site` | always | A 404 between two fleet sites is a link *we* broke. |
| `outbound` | `--outbound` only | Slow, hits third parties, and its failures are often transient or bot-blocked rather than genuine. |
| `/go/*` | never | Owned end-to-end by `tools/affiliate-link-check`, which knows about ASINs, OOS markers and Amazon's anti-bot pages. Two tools with different verdicts on the same URL trains people to ignore both. |
| `<img>`, `<script>`, `<link>` | never | Images have their own auditor; assets fail loudly in the build. |

Issues reported:

- **broken** — 4xx/5xx.
- **unreachable** — DNS, TLS, timeout, redirect loop.
- **page-unreachable** — a URL the site's own sitemap advertises that does not load.
- **redirect-chain** — resolves 200, but through ≥2 hops. Not broken; a fixable cost, and how a link quietly becomes broken later.

## Design notes

- **The sitemap is the page universe.** It is what the site claims to publish
  and what search engines crawl, and it costs one request. A breadth-first
  crawl would also find orphans — but that is a different finding for a
  different tool, and crawling 30 sites unbounded is how a cheap check becomes
  a thing nobody runs. A site with **no sitemap** is reported as an error
  rather than scored clean: the sweep is blind there, and so are crawlers.
- **One check per distinct URL.** A nav link appears on every page; checking it
  150 times would make cost scale with site size for no extra information.
- **Redirects are followed by hand.** urllib's default opener follows them
  silently, which would hide exactly the thing worth reporting.
- **HEAD first, GET on 403/405/501.** A server refusing HEAD is a preference,
  not a dead link.

## Known root causes found by the first run

Two patterns produced almost all 27:

1. **Relative links resolving against an article path.** `href="articles/foo"`
   without a leading slash, written on a page at `/articles/2026-05-01-bar/`,
   resolves to `/articles/2026-05-01-bar/articles/foo`. Hit americastrikes,
   amputeenews and saveusfarms — i.e. the writer roles on the news sites, not
   a per-site accident.
2. **Taxonomy pages linked but never generated.** `/tropes/*` (wetpages),
   `/vessels/*` (xxxtea), `/gear/*` (fishhooklabs) — the link template assumes
   a term page the content collection never emits for terms with no entries.

Plus one one-off worth its own mention: `saveusfarms.com/articles/` emitted a
literal `${t.href}` into the HTML — an unexpanded template literal, i.e. a
string that should have been an interpolation.
