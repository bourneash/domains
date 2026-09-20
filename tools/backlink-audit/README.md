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

## Bing capture

`run-bing-backlink-capture.sh` uses the current Bing Webmaster JSON API to collect
verified-site link counts, returned source URLs, anchors, and observed referring
domains. It writes dated reports under each site's `ops/seo/` directory; the
existing audit and Fleet Manager then pick them up automatically. By default the
scheduled job captures every Bing-verified site that also exists in the local
fleet. A restricted scope can be selected with
`BING_BACKLINK_SITES=domain-a.com,domain-b.com`.

The API key is rendered only for `fleet-cron` by env-broker from Vaultwarden. It
is not placed in the root `.env` or any site container. The importer is capped
by page, target, and detail-row limits and treats Bing's returned link data as a
representative baseline, not a complete backlink census.
