# gsc-verify

Verifies fleet domains in Google Search Console by writing a DNS TXT record
via the Cloudflare API, then verifying **as the service account**.

The Search Console API has no permissions endpoint — access cannot be granted
to a service account. A successful DNS verification instead makes the
verifying identity a verified owner. Multiple TXT records coexist, so Jesse
verifying separately for web-UI access does not conflict with this.

This clears a blocker open since 2026-05-06.

## Usage

    pip install -r requirements.txt
    python -m gsc_verify.cli --dry-run                    # report state only
    python -m gsc_verify.cli --domain xxxtea.com          # single domain
    python -m gsc_verify.cli                              # whole fleet

Requires `tools/data-hub/registry/sites-analytics.yaml` (written by
`tools/ga4-provision`) and `CLOUDFLARE_API_TOKEN` in the root `.env`.

## Behaviour

Idempotent. Already-verified domains are skipped without touching DNS.
A domain whose TXT record has not propagated within 5 minutes reports
`pending:dns-propagation` and keeps its record, so re-running resumes.
One domain failing never aborts the run.
