import hashlib
from datetime import datetime, timedelta, timezone
import datahub.datasets as _ds

DEFAULT_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"

# NVD's API returns results oldest-first with no sort param and no pagination
# here (single request/cycle to stay well under the unauthenticated 5-req/30s
# limit) — so the lookback window MUST stay small enough that total matching
# CVEs fit under RESULTS_PER_PAGE, or the oldest `resultsPerPage` results
# silently crowd out everything newer. NVD publishes ~80-110 CVEs/24h as of
# 2026-08, so 36h keeps real coverage comfortably under the 200 cap; 3 days
# was tried first and clipped to a two-minute slice of the oldest day (581
# total results, only the first 200 returned). This fetcher runs every 30
# min, so 36h of lookback is still ample margin for a missed cycle or two.
LOOKBACK_HOURS = 36
RESULTS_PER_PAGE = 200


def _stable_offset_micros(cve_id: str) -> int:
    """Same collision-avoidance trick as cisa_kev.py: the store's uniqueness
    key is (source_id, dataset_key, observed_at), and NVD occasionally
    publishes multiple CVEs with the same second-resolution timestamp —
    hash the CVE ID into a stable microsecond offset so same-timestamp
    entries don't collide and silently drop on INSERT OR IGNORE."""
    digest = hashlib.md5(cve_id.encode("utf-8")).hexdigest()
    return int(digest, 16) % 1_000_000


def _severity(metrics: dict) -> tuple[str, float | None]:
    """Best available CVSS severity + score across v3.1 > v3.0 > v2 metrics."""
    for key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
        entries = metrics.get(key) or []
        if not entries:
            continue
        data = entries[0].get("cvssData", {})
        score = data.get("baseScore")
        severity = data.get("baseSeverity") or entries[0].get("baseSeverity") or ""
        return severity, score
    return "", None


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    """NVD CVE 2.0 API — public JSON, no API key required (rate-limited to
    5 req/30s without one; this fetcher issues a single request per cycle,
    well under that).

    One record per newly-published CVE in the lookback window. observed_at
    is NVD's `published` timestamp (not the fetch time) so `since_iso`
    windowing reflects real publish time, matching the cisa_kev fetcher's
    convention.
    """
    url = source.params.get("url", DEFAULT_URL)
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=LOOKBACK_HOURS)
    params = {
        "pubStartDate": start.strftime("%Y-%m-%dT%H:%M:%S.000"),
        "pubEndDate": now.strftime("%Y-%m-%dT%H:%M:%S.000"),
        "resultsPerPage": RESULTS_PER_PAGE,
    }
    data = _ds._get_json(url, proxy=proxy, client=client, params=params)
    out = []
    for entry in data.get("vulnerabilities", []):
        cve = entry.get("cve", {})
        cve_id = cve.get("id") or ""
        published = cve.get("published")
        try:
            base = datetime.fromisoformat(published).astimezone(timezone.utc)
            observed = (base + timedelta(microseconds=_stable_offset_micros(cve_id))).isoformat()
        except (TypeError, ValueError):
            observed = now.isoformat()

        descriptions = cve.get("descriptions") or []
        summary = next((d.get("value", "") for d in descriptions if d.get("lang") == "en"), "")

        severity, score = _severity(cve.get("metrics") or {})

        refs = cve.get("references") or []
        url_ref = refs[0].get("url") if refs else ""

        out.append({"observed_at": observed, "payload": {
            "cve_id": cve_id,
            "summary": summary,
            "severity": severity,
            "cvss_score": score,
            "url": url_ref,
            "source_identifier": cve.get("sourceIdentifier"),
        }})
    return out
