# Fleet backlink audit

This is the fleet-wide backlink coverage and provenance inventory. It deliberately
does not invent backlink counts from search-engine snippets: a report is marked
`measured` only when its own text records a quantitative source such as Moz,
Bing Webmaster, Ahrefs, or DataForSEO.

Run it locally:

```sh
node tools/backlink-audit/audit.js --root /home/jesse/projects/domains
```

The scheduled job writes `tools/fleet-dashboard/data/backlinks-latest.json` and
appends a compact record to `backlinks-history.jsonl`. The Fleet Manager reads
the snapshot and can rebuild it on demand. This is intentionally a fleet tool,
not a per-site AI role: collection/provenance is deterministic and the operator
can file site work from the dashboard when a report is missing or stale.
