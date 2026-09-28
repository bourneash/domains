# nsfwpixles.com measurement and health boundary assessment

Assessment timestamp: 2026-09-28T18:03:20Z  
Role: seo-analyst  
Mode: report-only, read-only  
Scope: `nsfwpixles.com` only

## Executive disposition

`nsfwpixles.com` is an intentional typo-protection redirect asset, not an independently operated content site. Existing evidence supports documenting its redirect configuration and measurement boundary only. Traffic, revenue, conversions, attribution, SEO performance, public availability, compliance posture, and operational health are **unknown** unless directly evidenced below. No performance, revenue, ROI, or causal-lift claim is supported.

## Observed facts

| Area | Evidence observed | Boundary |
| --- | --- | --- |
| Registry | `registry/fleet.yaml` records `nsfwpixles.com` with lifecycle/status `redirect`, Cloudflare zone `nsfwpixles.com`, and no repo, Worker, or site capabilities. | This is a registry fact, not proof that the live redirect is currently healthy. |
| Asset design | `sites/nsfwpixles.com/README.md` describes a Cloudflare edge-only 301 from `nsfwpixles.com` and `www.nsfwpixles.com` to `https://nsfwpixels.com`, preserving path and query string. | README configuration is documentation; it is not a fresh production check. |
| Canonical relationship | The README identifies `nsfwpixels.com` as the canonical destination. `sites/nsfwpixles.com/THIS_IS_A_INTENTIONAL_TYPEO.md` confirms the spelling is intentional. | Do not rename, clone, or treat this directory as a normal site. |
| Analytics configuration | The approved task states analytics is not configured. No `nsfwpixles.com` entry is present in `tools/data-hub/registry/sites-analytics.yaml`. | No GA4/GSC property, measurement ID, sessions, users, or conversions may be inferred. |
| Public research | The approved task records that public research returned an HTTP error. | No HTTP status, redirect-chain result, availability, crawlability, indexation, or Core Web Vitals result is asserted from that failed research. |
| Revenue and attribution | `tools/fleet-dashboard/server/revenue.js` would read `tools/amz-stats/out/earnings-latest.json`; that export and the Associates session file are absent in this workspace. No site-specific tracking tag or revenue row is evidenced. | Revenue, commission, orders, clicks, attribution, ROI, and margin remain unknown; absence of an export is not zero revenue. |
| Compliance | The local compliance cache/history files are absent, so there is no cached site result for this domain. | HTTPS, consent, privacy/terms presence, and legal compliance status remain unknown. The technical baseline is not legal certification. |
| AI usage | The workspace contains only `ops/logs/.gitkeep`; no site-specific AI usage record is present for `nsfwpixles.com`. | AI calls, tokens, cost, and payback remain unknown, not zero. |
| Operations | No site-specific uptime, deploy-health, error, or fleet-doctor result is present in the checked-in evidence. | Operational health, incident status, and availability remain unknown. |

## Measurement boundary

The following fields are intentionally left unknown:

- traffic: sessions, users, page views, referrers, and audience behavior;
- conversions: goals, form submissions, redirect clicks, or downstream canonical-site conversions attributable to this typo domain;
- SEO: impressions, clicks, rankings, indexed URLs, crawlability, sitemap status, backlinks, and Core Web Vitals;
- revenue and attribution: orders, commission, income, affiliate clicks, ROI, margin, and any site-level allocation;
- health: current HTTP behavior, redirect-chain correctness, uptime, TLS, errors, deploy state, and incident state;
- compliance: consent behavior, privacy/terms availability, and legal readiness;
- AI usage: site-specific calls, tokens, cost, and outcomes.

The only supported interpretation is that this is a registered redirect asset whose intended configuration is documented locally. A redirect README, a missing telemetry mapping, or a failed public check cannot establish live health or business performance.

## Prioritized recommendations

1. **P0 — Preserve the boundary.** Keep the domain classified as a redirect asset. Do not add analytics, affiliate tags, advertising, credentials, duplicate telemetry, production configuration, or content without an owner-approved change request that names the exact property/account and consent/compliance requirements.
2. **P1 — Validate the existing redirect only when authorized.** An owner-authorized read-only check should test apex, `www`, a representative path, query-string preservation, HTTPS behavior, and the final canonical destination. Record timestamp, status codes, `Location` headers, and any failure; do not modify the Cloudflare rule or DNS.
3. **P1 — Establish an evidence owner if measurement is required.** The owner must supply the authoritative analytics/SEO property mapping and access path for this domain, if one exists. Until then, keep all analytics and SEO fields unknown.
4. **P2 — Reconcile attribution only if revenue evidence is later supplied.** The owner must supply an authoritative provider export and an exact site tracking ID mapping. Do not assign aggregate or unmatched provider rows to this domain.

## Validation criteria for a future follow-up

Validation is outside this report-only delivery. If separately authorized, accept the follow-up only when it provides:

- a dated, read-only HTTP evidence bundle for both host variants, path/query preservation, and final destination;
- an owner-supplied analytics/GSC mapping, or an explicit owner confirmation that this redirect intentionally has no telemetry;
- dated evidence for any claimed traffic, conversions, or canonical-site attribution, with the attribution method stated;
- a dated compliance/operations evidence record with source and freshness; and
- for any revenue claim, a provider export plus an exact, owner-approved tracking-ID mapping. Unmatched or aggregate revenue must remain unattributed.

No recommendation above authorizes deployment, DNS or redirect edits, credentials, schedules, configuration, spending, or production-data changes.

## Rollback and follow-up notes

- This delivery made no production, credential, configuration, telemetry, schedule, spending, DNS, or task-queue change.
- Rollback for this artifact is limited to removing or reverting this report file during dashboard review; no production rollback is applicable.
- The approved backlog task remains unchanged. A future validation should be a new owner-approved evidence action, not a claim that this report established live health.
- A focused local source-check attempt could not load the dashboard registry module because the workspace lacks the `js-yaml` dependency. This does not change the evidence boundary; registry facts above were read directly from the checked-in YAML and site README.

## Evidence index

- `registry/fleet.yaml` — redirect lifecycle and Cloudflare zone.
- `sites/nsfwpixles.com/README.md` — documented edge redirect, DNS, email-routing, and intended verification commands.
- `sites/nsfwpixles.com/THIS_IS_A_INTENTIONAL_TYPEO.md` — intentional spelling/asset boundary.
- `tools/data-hub/registry/sites-analytics.yaml` — no analytics mapping for `nsfwpixles.com`.
- `tools/fleet-dashboard/server/revenue.js` — authoritative local export paths and attribution rules; export/session files absent at assessment time.
- `sites/nsfwpixles.com/ops/tasks/backlog/2026-09-28-run-nsfwpixles-com-measurement-and-health-boundary-assessmen.md` — owner-approved scope and explicit HTTP-error/unknown-field constraints.
