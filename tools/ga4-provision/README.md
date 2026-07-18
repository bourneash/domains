# ga4-provision

One-time, interactive. Grants the fleet service account Viewer on every GA4
property and writes the canonical site registry.

Exists because the GA4 Admin API allows granting access, but a service account
cannot grant itself access to properties it cannot see. Run once as Jesse;
everything afterwards is unattended.

## Usage

    pip install -r ../google-auth/requirements.txt
    python -m ga4_provision.cli --dry-run   # discover + report, change nothing
    python -m ga4_provision.cli             # write registry + grant

Opens a browser for Google sign-in on first run. The cached token at
`.gcp/ga4-provision-token.json` is a convenience for re-runs only — nothing
recurring depends on it.

## Output

`tools/data-hub/registry/sites-analytics.yaml` — consumed by the metrics
collector. Do not hand-edit; re-run this tool instead.
