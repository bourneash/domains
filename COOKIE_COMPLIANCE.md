# Cookie and Analytics Compliance

The Fleet Dashboard **Compliance** section is the source of truth for the current technical privacy baseline. This file no longer contains manually maintained site statuses.

Open Fleet Dashboard at `http://127.0.0.1:4754/#compliance` and select **Scan live sites now** to verify every discovered domain against its deployed homepage and same-origin JavaScript bundles.

## Current automated checks

- Live HTTPS homepage reachability
- Cookie consent banner or dialog
- Accept choice
- Reject or decline choice
- GA4 presence and measurement IDs
- Default-denied Google consent mode or evidence of basic consent gating when GA4 is present
- Privacy-policy link
- Terms link

Results are reported as **pass**, **fail**, or **unknown**. An unreachable or unscanned site is always **unknown**, never assumed compliant or noncompliant. These checks are a technical baseline and not legal advice or a legal certification.

The scanner runs when Fleet Dashboard starts, refreshes hourly, and can be run on demand. Its implementation and tests live in `tools/fleet-dashboard/server/compliance.js` and `tools/fleet-dashboard/server/compliance.test.js`.
